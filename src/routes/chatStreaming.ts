import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { logStore } from '../services/logStore.ts';
import { sessionPool } from '../services/sessionPool.ts';
import type { Message, OpenAIRequest } from '../types/openai.ts';
import { type AmplificationGuardState } from './chatHelpers.ts';
import { type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { cleanupImmediately } from './cleanupHelpers.ts';
import { handlePostStreamCompletion, runStreamLoop } from './streamLoop.ts';
import { buildChunkEvent, makeChoice, writeEvent, writeSseErrorEvent } from './writeHelpers.ts';

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  qwenLogFile?: string;
  /** Mutable signal set by streaming processor when mid-stream RateLimited requires retry. */
  retrySignal?: { needsRetry: boolean; failedEmail: string };
  /** Callback to re-acquire session with a new account for mid-stream retry. */
  retrySetup?: () => Promise<{
    session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
    stream: ReadableStream;
    qwenAbortController: AbortController;
    resolvedEmail: string;
    nextParentId: string | null;
    sessionHeaders: any;
  }>;
}

const MAX_STREAM_RETRIES = 3;

function buildPromptString(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = Array.isArray(m.content)
        ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
        : String(m.content ?? '');
      return `${m.role}: ${content}`;
    })
    .join('\n\n');
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, session, stream, qwenAbortController, resolvedEmail, sessionHeaders, cleanOutput, retrySignal, retrySetup } = ctx;
  const finalPrompt = buildPromptString(body.messages);
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');
  return honoStream(c, async (streamWriter: any) => {
    const _streamStartTime = Date.now();
    logStore.log('debug', 'stream', `[Stream] >>> Streaming started for ${logId}, model=${body.model}, tools=${body.tools?.length || 0}`);
    let streamReleased = false;
    let heartbeatInterval: any;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };

    // Mutable state for retry loop — updated on each attempt with new session/stream
    let curSession = session;
    let curStream = stream;
    let curAbort = qwenAbortController;
    let curEmail = resolvedEmail;
    let curHeaders = sessionHeaders;
    let curParentId = ctx.initialParentId;

    try {
      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
        if (attempt > 0) {
          logStore.log('info', 'stream', `[Stream] Retry attempt ${attempt}/${MAX_STREAM_RETRIES} for ${logId}`);
        }
        heartbeatInterval = createHeartbeat(streamWriter);
        // Only emit the initial role chunk on the first attempt
        if (attempt === 0) {
          await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));
        }
        streamReader = curStream.getReader();
        const reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
        const enableContentFiltering = cleanOutput;
        const streamState = buildInitialStreamState(finalPrompt, curParentId);
        const streamCtx: StreamProcessingCtx = {
          streamWriter,
          completionId,
          model: body.model,
          enableContentFiltering,
          cleanOutput,
          logId,
          resolvedEmail: curEmail,
          ampState,
          qwenAbortController: curAbort,
          qwenLogFile: ctx.qwenLogFile,
          emittedToolCallCount: 0,
          tools: ctx.body.tools,
          retryWithNewAccount: (failedEmail: string) => {
            if (retrySignal) {
              retrySignal.needsRetry = true;
              retrySignal.failedEmail = failedEmail;
            }
          },
        };
        const bufferRef = { text: '' };
        const loopResult = await runStreamLoop(c, reader, streamState, streamCtx, ampState, bufferRef);

        // Mid-stream RateLimited — retry with new account if possible
        // UNLESS partial content was already emitted (can't unsend it)
        if (loopResult.retryAccount) {
          const partialEmitted = ampState.emittedOutputBytes > 0 || ampState.triggered;
          if (partialEmitted) {
            logStore.log('warn', 'stream', `[Stream] RateLimited but partial content already emitted (${ampState.emittedOutputBytes} bytes) — skipping retry for ${curEmail}`);
            // Emit SSE error so the client treats the whole stream as failed and retries
            try { await writeSseErrorEvent(streamWriter, { message: `RateLimited: partial content emitted but upstream hit limit (${curEmail})`, type: 'api_error', code: 'api_error' }); } catch {}
            try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
            logStore.updateEntry(logId, (entry) => {
              entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
              entry.finalResponse.finishReason = 'error';
            });
            logStore.finalizeRequest(ctx.logId);
            cleanupImmediately(
              streamReader, heartbeatInterval,
              curSession.chatId, curParentId, curHeaders, curEmail,
              sessionPool, false,
            );
            streamReleased = true;
            break;
          }
          // Clean up current session without emitting content
          cleanupImmediately(
            streamReader, heartbeatInterval,
            curSession.chatId, curParentId, curHeaders, curEmail,
            sessionPool, false,
          );
          streamReleased = true;
          heartbeatInterval = undefined;
          streamReader = null;

          if (attempt < MAX_STREAM_RETRIES && retrySetup) {
            try {
              const ns = await retrySetup();
              curSession = ns.session;
              curStream = ns.stream;
              curAbort = ns.qwenAbortController;
              curEmail = ns.resolvedEmail;
              curHeaders = ns.sessionHeaders;
              curParentId = ns.nextParentId;
              if (retrySignal) { retrySignal.needsRetry = false; retrySignal.failedEmail = ''; }
              streamReleased = false;
              continue;
            } catch (retryErr: any) {
              logStore.log('error', 'stream', `[Stream] Retry setup failed for ${logId}: ${retryErr.message}`);
              logStore.addError(logId, `Retry setup failed: ${retryErr.message}`);
              // Fall through to clean termination below
            }
          }

          // Exhausted retries or setup failed — emit a real error so the client
          // retries instead of receiving an empty [DONE] that looks like success.
          try { await writeSseErrorEvent(streamWriter, { message: `RateLimited: all accounts reached their daily usage limit (${curEmail})`, type: 'api_error', code: 'api_error' }); } catch {}
          try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
          logStore.updateEntry(logId, (entry) => {
            entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
            entry.finalResponse.finishReason = 'error';
          });
          logStore.finalizeRequest(ctx.logId);
          break;
        }

        if (loopResult.error) {
          logStore.log('debug', 'stream', `[Chat] Stream timeout for ${logId}: ${loopResult.error}`);
          logStore.addError(logId, loopResult.error);
          // Emit SSE error so the client treats the stream as failed and retries
          await writeSseErrorEvent(streamWriter, { message: loopResult.error, code: 'upstream_idle_timeout' });
          await streamWriter.write('data: [DONE]\n\n');
          logStore.updateEntry(logId, (entry) => {
            if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
            if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
            entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
            entry.finalResponse.finishReason = 'error';
          });
          logStore.finalizeRequest(ctx.logId);
          cleanupImmediately(
            streamReader, heartbeatInterval,
            curSession.chatId, curParentId, curHeaders, curEmail,
            sessionPool, false,
          );
          streamReleased = true;
          break;
        }
        const postResult = await handlePostStreamCompletion(
          {
            streamWriter, completionId, model: body.model,
            streamState, ampState, logId,
            resolvedEmail: curEmail,
            emittedToolCallCount: streamCtx.emittedToolCallCount,
            buffer: loopResult.buffer,
            enableContentFiltering,
            includeUsage: !!body.stream_options?.include_usage,
            tools: body.tools,
            streamError: streamCtx.streamError,
            // Every attempt must flush its own pending tool/content state. A retry
            // may not duplicate already-emitted deltas, but skipping finalization
            // leaves the successful attempt without tool_calls/finish/[DONE].
            skipPostStream: false,
          },
          {
            reader, heartbeatInterval,
            chatId: curSession.chatId,
            sessionHeaders: curHeaders,
            email: curEmail,
            sessionPool,
          },
        );
        streamReleased = true;

        // Post-stream RateLimited — retry with new account if possible
        // UNLESS partial content was already emitted in this attempt
        if (postResult.retryAccount) {
          const partialEmitted = ampState.emittedOutputBytes > 0 || ampState.triggered;
          if (partialEmitted) {
            logStore.log('warn', 'stream', `[Stream] RateLimited but partial content already emitted (${ampState.emittedOutputBytes} bytes) — skipping retry for ${curEmail}`);
            // Emit SSE error so the client treats the whole stream as failed and retries
            try { await writeSseErrorEvent(streamWriter, { message: `RateLimited: partial content emitted but upstream hit limit (${curEmail})`, type: 'api_error', code: 'api_error' }); } catch {}
            try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
            logStore.updateEntry(logId, (entry) => {
              entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
              entry.finalResponse.finishReason = 'error';
            });
            logStore.finalizeRequest(ctx.logId);
            break;
          }
          // Session already released by handlePostStreamCompletion (scheduleCleanup called inside)
          heartbeatInterval = undefined;
          streamReader = null;

          if (attempt < MAX_STREAM_RETRIES && retrySetup) {
            try {
              const ns = await retrySetup();
              curSession = ns.session;
              curStream = ns.stream;
              curAbort = ns.qwenAbortController;
              curEmail = ns.resolvedEmail;
              curHeaders = ns.sessionHeaders;
              curParentId = ns.nextParentId;
              streamReleased = false;
              continue;
            } catch (retryErr: any) {
              logStore.log('error', 'stream', `[Stream] Post-stream retry setup failed for ${logId}: ${retryErr.message}`);
              logStore.addError(logId, `Post-stream retry setup failed: ${retryErr.message}`);
            }
          }

          // Exhausted retries or setup failed — emit a real error so the client
          // retries instead of receiving an empty [DONE] that looks like success.
          try { await writeSseErrorEvent(streamWriter, { message: `RateLimited: all accounts reached their daily usage limit (${curEmail})`, type: 'api_error', code: 'api_error' }); } catch {}
          try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
          logStore.updateEntry(logId, (entry) => {
            entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
            entry.finalResponse.finishReason = 'error';
          });
          logStore.finalizeRequest(ctx.logId);
          break;
        }

        logStore.log('debug', 'stream', `[Stream] <<< Streaming completed for ${logId} in ${Date.now() - _streamStartTime}ms`);
        break;
      }
    } finally {
      if (!streamReleased) {
        try {
          await streamWriter.write('data: [DONE]\n\n');
        } catch {
          /* stream may already be closed */
        }
        logStore.updateEntry(logId, (entry) => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = entry.finalResponse.finishReason || 'error';
        });
        logStore.finalizeRequest(ctx.logId);
        cleanupImmediately(
          streamReader, heartbeatInterval,
          curSession.chatId, curParentId, curHeaders, curEmail,
          sessionPool, false,
        );
      }
    }
  });
}

function createHeartbeat(streamWriter: any): any {
  const hb = setInterval(async () => {
    try {
      await streamWriter.write(': keep-alive\n\n');
    } catch {
      clearInterval(hb);
    }
  }, 15000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  return hb;
}

function buildInitialStreamState(finalPrompt: string, initialParentId: string | null): StreamProcessingState {
  return {
    knownResponseIds: new Set<string>(),
    nextParentId: initialParentId,
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
  };
}
