import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { dumpUpstreamDiagnostics } from '../services/networkDebug.ts';
import { setAccountDisabled } from '../services/accountManager.ts';
import { parseXmlToolCalls } from '../tools/xmlToolParser.ts';
import { type AmplificationGuardState, checkAmplificationGuard, getSnapshotDelta, parseQwenErrorPayload } from './chatHelpers.ts';
import { filterContentPipeline, processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { checkFinalAmplification, scheduleCleanup } from './cleanupHelpers.ts';
import { buildChunkEvent, buildUsage, makeChoice, writeEvent, writeReasoningEvent, writeSseErrorEvent, writeToolCallEvent } from './writeHelpers.ts';
import { alignArgsToSchema, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';

/** Shared TextDecoder — stateless, safe to reuse across streams */
export const sharedDecoder = new TextDecoder();

export interface StreamLoopResult {
  buffer: string;
  nextParentId: string | null;
  error?: string;
  /** When true, the stream was terminated by mid-stream RateLimited — caller should retry with next account. */
  retryAccount?: boolean;
}

export interface PostStreamResult {
  /** When true, post-stream flush detected RateLimited before any content was emitted — caller should retry with next account. */
  retryAccount: boolean;
}

export async function runStreamLoop(
  c: { req: { raw?: { signal?: AbortSignal } } },
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamState: StreamProcessingState,
  streamCtx: StreamProcessingCtx,
  ampState: AmplificationGuardState,
  bufferRef: { text: string },
): Promise<StreamLoopResult> {
  let streamDone = false;
  let nextParentId = streamState.nextParentId;

  while (true) {
    if (streamDone) break;
    if (c.req.raw?.signal?.aborted) {
      reader.cancel();
      break;
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let readResult: Awaited<ReturnType<typeof reader.read>>;
    let idleTimedOut = false;
    try {
      readResult = await Promise.race([
        reader.read(),
        new Promise<any>((_, reject) => {
          idleTimer = setTimeout(
            () => {
              idleTimedOut = true;
              reject(
                new Error(
                  `Upstream stream idle timeout — no data for ${Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 180000)) / 1000}s`,
                ),
              );
            },
            Math.max(10_000, config.getInt('STREAM_IDLE_TIMEOUT_MS', 180000)),
          );
        }),
      ]);
    } catch (timeoutErr) {
      if (idleTimer) clearTimeout(idleTimer);
      if (!idleTimedOut) await reader.cancel();
      return { buffer: bufferRef.text, nextParentId, error: (timeoutErr as Error).message };
    }
    if (idleTimer) clearTimeout(idleTimer);
    if (readResult.done) break;
    if (readResult.value) ampState.rawInputBytes += readResult.value.length;

    const rawDecoded = sharedDecoder.decode(readResult.value, { stream: true });
    bufferRef.text += rawDecoded;
    const lines = bufferRef.text.split('\n');
    bufferRef.text = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') {
        streamDone = true;
        break;
      }

      try {
        const chunk = JSON.parse(dataStr);

        const result = await processStreamData(chunk, streamState, streamCtx);
        if (result === 'break_stream') {
          streamDone = true;
          break;
        }
        if (result === 'retry_account') {
          streamDone = true;
          // Return immediately — caller will restart with next account.
          // Don't emit any partial content; the client sees a clean retry.
          return { buffer: bufferRef.text, nextParentId, retryAccount: true };
        }
      } catch (e) {
        console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message, 'raw:', dataStr.slice(0, 200));
      }
    }
    nextParentId = streamState.nextParentId;
  }

  return { buffer: bufferRef.text, nextParentId };
}

export async function handlePostStreamCompletion(
  args: {
    streamWriter: any;
    completionId: string;
    model: string;
    streamState: StreamProcessingState;
    ampState: AmplificationGuardState;
    logId: string;
    resolvedEmail: string;
    emittedToolCallCount: number;
    buffer: string;
    enableContentFiltering: boolean;
    includeUsage: boolean;
    /** Client-registered tool schemas; used to align flush-time tool-call arg names to the schema's casing. */
    tools?: any[];
    /** When true, skip post-stream processing — caller is retrying with a new account. */
    skipPostStream?: boolean;
    /** Non-RateLimited upstream error caught mid-stream by processStreamData
     *  (e.g. quota_limit). The SSE line was consumed, so parseQwenErrorPayload(buffer)
     *  can't see it — this is the authoritative signal. */
    streamError?: { message: string; type?: string; code?: string; upstreamCode?: string };
  },
  cleanup: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    heartbeatInterval: any;
    chatId: string;
    sessionHeaders: any;
    email: string;
    sessionPool: { release: (chatId: string, parentId: string | null, headers: any, email: string) => void };
  },
): Promise<PostStreamResult> {
  const {
    streamWriter,
    completionId,
    model,
    streamState,
    ampState,
    logId,
    resolvedEmail,
    emittedToolCallCount,
    buffer,
    enableContentFiltering,
    includeUsage,
    skipPostStream,
    streamError,
  } = args;
  const { reader, heartbeatInterval, chatId, sessionHeaders, email, sessionPool } = cleanup;
  let skipFinallyCleanup = false;

  try {
    // Mid-stream non-RateLimited upstream error (quota_limit etc.) captured by
    // processStreamData. The SSE line was consumed during the read loop so
    // parseQwenErrorPayload(buffer) below can't see it — emit a real error event
    // so downstream treats the stream as failed instead of a clean stop.
    // Checked BEFORE the skipPostStream short-circuit so a retry attempt that
    // hits an upstream error still surfaces it to the client.
    if (streamError) {
      logStore.log('warn', 'stream', `[Qwen] Upstream stream error: ${streamError.message} (logId=${logId})`);
      await writeSseErrorEvent(streamWriter, {
        message: streamError.message,
        type: streamError.type,
        code: streamError.code,
        upstreamCode: streamError.upstreamCode,
      });
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_error';
      });
      logStore.finalizeRequest(logId);
      return { retryAccount: false };
    }

    // When the caller is retrying with a new account after mid-stream RateLimited,
    // skip all post-stream processing — don't re-flush content already emitted
    // per-chunk during this attempt's loop. Cleanup happens in the finally block.
    // Placed AFTER the streamError check above so a retry attempt that hits a
    // non-RateLimited upstream error still surfaces it to the client.
    if (skipPostStream) {
      return { retryAccount: false };
    }

    const upstreamError = parseQwenErrorPayload(buffer);
    if (upstreamError) {
      if (upstreamError.upstreamCode === 'RateLimited' && resolvedEmail) {
        setAccountDisabled(resolvedEmail, true);
        logStore.log('warn', 'qwen', `[Qwen] RateLimited via post-stream flush: disabled ${resolvedEmail} and switching account — ${upstreamError.message}`);
        // Clean up immediately so caller can acquire a new session without race
        scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool, false);
        skipFinallyCleanup = true;
        return { retryAccount: true };
      }
      try {
        require('fs').writeFileSync('/tmp/qwen-error-buffer.json', buffer.slice(0, 10000));
      } catch (e) {}
      await writeSseErrorEvent(streamWriter, {
        message: upstreamError.message,
        code: upstreamError.code,
        upstreamCode: upstreamError.upstreamCode,
        status: upstreamError.status,
      });
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_error';
      });
      logStore.finalizeRequest(logId);
      return { retryAccount: false };
    }

    // Flush any pending chunk left in the one-chunk buffer
    if (streamState.pendingChunk) {
      streamState.lastFullContent += streamState.pendingChunk;
      streamState.pendingChunk = '';
    }

    // Count tool calls from the final assembled content
    const parsedFinalToolCalls = streamState.lastFullContent
      ? parseXmlToolCalls(streamState.lastFullContent).toolCalls
      : [];
    const canonicalJson = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    };
    const flushOccurrences = new Map<string, number>();
    const flushToolCalls = parsedFinalToolCalls.filter((tc) => {
      const baseKey = `${tc.name}:${canonicalJson(tc.parameters)}`;
      const occurrence = flushOccurrences.get(baseKey) || 0;
      flushOccurrences.set(baseKey, occurrence + 1);
      return !streamState.loggedToolCalls.has(`${baseKey}:${occurrence}`);
    });
    const effectiveToolCallCount = emittedToolCallCount + flushToolCalls.length;

    // Populate parsedToolCalls from full accumulated content (per-chunk extraction
    // never sees complete blocks since individual SSE deltas are too small).
    if (parsedFinalToolCalls.length > 0) {
      // local_mcp and XML calls can be interleaved. Slicing by count assumes
      // both formats have the same order and drops valid XML calls whenever a
      // local_mcp call was emitted first. Match by name + canonical arguments.
      // Avoid double-counting calls already emitted from the per-chunk path.
      for (const tc of flushToolCalls) {
        logStore.updateEntry(logId, (entry) => {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        });
      }
      // Emit the tool calls that were only assembled at flush time (e.g. completed
      // from the pendingChunk buffer) as SSE events. Without this the client sees
      // finish_reason:"tool_calls" but never receives a tool_calls chunk, so the
      // turn dead-ends. Mirror the per-chunk path: align args + writeToolCallEvent.
      for (let i = 0; i < flushToolCalls.length; i++) {
        const parsedCall = xmlToolCallToParsed(flushToolCalls[i], emittedToolCallCount + i);
        parsedCall.arguments = alignArgsToSchema(parsedCall.name, parsedCall.arguments, args.tools);
        await writeToolCallEvent(streamWriter, completionId, model, parsedCall, emittedToolCallCount + i);
      }
    }

    const pipelineResult = filterContentPipeline(streamState.lastFullContent, enableContentFiltering);
    const flushCleaned = pipelineResult.cleanText;
    const flushThinking = pipelineResult.thinking;

    if (flushThinking) {
      const thinkDelta = getSnapshotDelta(flushThinking, streamState.lastThinkingSnapshot);
      if (thinkDelta) {
        streamState.lastThinkingSnapshot = flushThinking;
        await writeReasoningEvent(streamWriter, completionId, model, thinkDelta);
      }
    }
    if (flushCleaned) {
      const contentDelta = getSnapshotDelta(flushCleaned, streamState.lastFilteredSnapshot);
      if (contentDelta) {
        streamState.lastFilteredSnapshot = flushCleaned;
        if (
          checkAmplificationGuard(
            ampState,
            contentDelta.length,
            logId,
            resolvedEmail,
            model,
            streamState.lastRawContent,
            streamState.lastVStrRaw,
          )
        ) {
          // guard triggered — skip content emission
        } else {
          const ct = contentDelta.replace(/[\n\s]*$/, '');
          if (ct) {
            logStore.addProcessedOutput(logId, ct);
            ampState.emittedOutputBytes += ct.length;
            await writeEvent(streamWriter, buildChunkEvent(completionId, model, [makeChoice({ content: ct })]));
          }
        }
      }
    }

    const usage = buildUsage(streamState.promptTokens, streamState.completionTokens, streamState.reasoningBuffer);
    const finalFinishReason = effectiveToolCallCount > 0 ? 'tool_calls' : 'stop';

    // Upstream ended normally ([DONE] / finished) but produced zero answer
    // content and zero tool calls. This is the "empty stream" pattern: Qwen
    // returns a 200 + end signal with no usable answer for some long
    // conversations — sometimes thinking-only, sometimes nothing at all.
    // reasoning_content is internal deliberation, NOT a user-facing answer, so a
    // thinking-only turn with an empty answer is still a failed turn. Returning
    // it as a clean `stop` shows the user an empty reply and makes the downstream
    // agent think the task completed — the "conversation ended for no reason"
    // symptom. Surface it as an explicit error so downstream retries.
    if (
      finalFinishReason === 'stop' &&
      !streamState.lastFullContent &&
      effectiveToolCallCount === 0
    ) {
      const emptyMsg = 'Upstream returned an empty answer (no content, no tool calls)';
      logStore.log('warn', 'stream', `[Qwen] ${emptyMsg} (logId=${logId})`);
      // Diagnostic: snapshot recent upstream network entries + buffer so a
      // 200-empty vs mid-stream-drop vs no-connection case can be told apart.
      dumpUpstreamDiagnostics({
        logId,
        accountEmail: resolvedEmail,
        model,
        stream: true,
        trigger: 'stream_empty',
        bufferSnippet: buffer,
      });
      await writeSseErrorEvent(streamWriter, { message: emptyMsg, code: 'upstream_empty' });
      await streamWriter.write('data: [DONE]\n\n');
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'upstream_empty';
      });
      logStore.finalizeRequest(logId);
      return { retryAccount: false };
    }

    await writeEvent(
      streamWriter,
      buildChunkEvent(completionId, model, [makeChoice({}, finalFinishReason)], includeUsage ? undefined : { usage }),
    );

    if (includeUsage) {
      await writeEvent(streamWriter, buildChunkEvent(completionId, model, [], { usage }));
    }
    await streamWriter.write('data: [DONE]\n\n');

    checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

    logStore.updateEntry(logId, (entry) => {
      const now = Date.now();
      const startedAt = new Date(entry.timestamp).getTime();
      if (startedAt) entry.latency_ms = now - startedAt;
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = {
        finishReason: finalFinishReason || 'stop',
        toolCallCount: effectiveToolCallCount,
        contentPreview: (streamState.lastFullContent || '').substring(0, 100),
      };
    });

    logStore.finalizeRequest(logId);
    return { retryAccount: false };
  } catch (err) {
    console.error('[Chat] handlePostStreamCompletion error:', err);
    const errMsg = err instanceof Error ? err.message : String(err);
    logStore.addError(logId, errMsg);
    // Preserve data that was set before flush (content, reasoning, etc.)
    logStore.updateEntry(logId, (entry) => {
      if (streamState.lastFullContent) entry.remainingText = streamState.lastFullContent;
      if (streamState.reasoningBuffer) entry.reasoningContent = streamState.reasoningBuffer;
      entry.finalResponse = entry.finalResponse || { finishReason: 'error', toolCallCount: 0, contentPreview: '' };
    });
    logStore.finalizeRequest(logId);
    // Emit SSE error event so the client (Claude Code/Codex) treats this as an
    // API error and retries, rather than showing the error text as model output.
    try { await writeSseErrorEvent(streamWriter, { message: errMsg }); } catch {}
    // Always write [DONE] so the SSE stream terminates cleanly, even on error
    try { await streamWriter.write('data: [DONE]\n\n'); } catch {}
    return { retryAccount: false };
  } finally {
    // Release session unless the RateLimited path already did it
    if (!skipFinallyCleanup) {
      scheduleCleanup(reader, heartbeatInterval, chatId, streamState.nextParentId, sessionHeaders, email, sessionPool);
    }
  }
}
