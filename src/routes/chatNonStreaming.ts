import { Context } from 'hono';
import { logStore } from '../services/logStore.ts';
import { dumpUpstreamDiagnostics } from '../services/networkDebug.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { setAccountDisabled, throttleAccount } from '../services/accountManager.ts';
import { detectParallelToolLoop } from '../tools/guard.ts';
import type { Message, OpenAIRequest, ParsedToolCall } from '../types/openai.ts';
import {
  commonPrefixLen,
  normalizeAnswerChunk,
  type AnswerChunkMode,
  parseQwenErrorPayload,
  pendingCorrections,
  processToolCallsThroughGuard,
  ToolSpamGuard,
} from './chatHelpers.ts';
const MAX_TOOL_CALLS_PER_TURN = 8;
import { cleanTextOfXmlArtifacts, alignArgsToSchema } from '../tools/xmlToolParser.ts';
import {
  consumeNonceToolChunk,
  createNonceToolStreamState,
  flushNonceToolStream,
  type NonceToolStreamState,
} from '../tools/nonceToolStream.ts';

export interface NonStreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  /** Mutable signal set when RateLimited is detected — caller checks after return. */
  retrySignal?: { needsRetry: boolean; failedEmail: string };
  toolNonce?: string;
}

interface StreamProcessorState {
  reader: ReadableStreamDefaultReader;
  decoder: TextDecoder;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  /** Raw answer snapshot used only for cumulative-delta detection. */
  lastAnswerRaw: string;
  answerChunkMode: AnswerChunkMode;
  nonceToolStream?: NonceToolStreamState;
  toolProtocolError?: string;
  knownResponseIds: Set<string>;
  toolCallsOut: any[];
  correctionPrompts: string[];
  toolSpamGuard: ToolSpamGuard;
  buffer: string;
  completionTokens: number;
  promptTokens: number;
  nextParentId: string | null;
  /** Non-RateLimited upstream error caught mid-stream (e.g. quota_limit).
   *  The SSE line was consumed by parseQwenResponse, so parseQwenErrorPayload(buffer)
   *  can't see it — this is the authoritative signal checked in processContentChunks. */
  upstreamError?: {
    message: string;
    code?: string;
    upstreamCode?: string;
    status?: import('hono/utils/http-status').ContentfulStatusCode;
  };
}

function buildUpstreamErrorResponse(err: any, fallbackStatus = 500): { body: any; status: number } {
  const status = err?.upstreamStatus || err?.status || fallbackStatus;
  const cleanMessage = cleanTextOfXmlArtifacts(err?.message || String(err)).cleanedText || err?.message || 'Internal error';
  const error: Record<string, any> = {
    message: cleanMessage,
    type: err?.type || 'server_error',
  };
  if (err?.message !== undefined) error.upstream_message = err.message;
  if (err?.code !== undefined) error.code = err.code;
  if (err?.upstreamCode !== undefined) error.upstream_code = err.upstreamCode;
  if (err?.upstreamStatus !== undefined) error.upstream_status = err.upstreamStatus;
  if (err?.retryAfterMs !== undefined) error.retry_after_ms = err.retryAfterMs;
  return { body: { error }, status };
}

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

function buildQwenRequest(ctx: NonStreamingContext): StreamProcessorState {
  const reader = ctx.stream.getReader();
  const finalPrompt = buildPromptString(ctx.body.messages);
  return {
    reader,
    decoder: new TextDecoder(),
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastAnswerRaw: '',
    answerChunkMode: 'unknown',
    nonceToolStream: ctx.toolNonce ? createNonceToolStreamState() : undefined,
    knownResponseIds: new Set<string>(),
    toolCallsOut: [],
    correctionPrompts: [],
    toolSpamGuard: new ToolSpamGuard(),
    buffer: '',
    completionTokens: 0,
    promptTokens: Math.ceil(finalPrompt.length / 3.5),
    nextParentId: ctx.initialParentId,
  };
}

function processThinkingDelta(delta: any, state: StreamProcessorState): void {
  if (delta.phase === 'thinking_summary') {
    const thoughts = delta.extra?.summary_thought?.content;
    if (!thoughts) return;
    const rawNew = thoughts.slice(state.currentThoughtIndex).join('\n');
    if (!rawNew) return;
    const commonLen = commonPrefixLen(rawNew, state.reasoningBuffer);
    const vStr = rawNew.substring(commonLen);
    if (!vStr) return;
    state.currentThoughtIndex = thoughts.length;
    state.reasoningBuffer += vStr;
    return;
  }
  if (delta.phase === 'think') {
    if (delta.content !== undefined && delta.content !== '') {
      state.reasoningBuffer += delta.content;
    }
    return;
  }
}

function processAnswerDelta(delta: any, state: StreamProcessorState, ctx: NonStreamingContext): void {
  if (delta.content === undefined) return;
  const vStr = delta.content || '';
  if (!vStr || vStr === 'FINISHED') return;
  logStore.addRawChunk(ctx.logId, vStr);

  let rawText = vStr;
  const normalized = normalizeAnswerChunk(vStr, state.lastAnswerRaw, state.answerChunkMode);
  rawText = normalized.delta;
  state.lastAnswerRaw = normalized.previousChunk;
  state.answerChunkMode = normalized.mode;
  if (!rawText) return;

  if (ctx.toolNonce && state.nonceToolStream) {
    const result = consumeNonceToolChunk(state.nonceToolStream, rawText, ctx.toolNonce, ctx.body.tools);
    if (result.error) {
      state.toolProtocolError = result.error;
      return;
    }
    state.lastFullContent += result.content;
    if (result.toolCalls.length > 0) {
      processToolCallsThroughGuard(result.toolCalls, state.toolCallsOut, {
        logId: ctx.logId,
        toolSpamGuard: state.toolSpamGuard,
        correctionPrompts: state.correctionPrompts,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
        logParsed: true,
      });
    }
    return;
  }

  state.lastFullContent += rawText;
}

function parseQwenResponse(line: string, state: StreamProcessorState, ctx: NonStreamingContext): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  // Check for Qwen WAF/CAPTCHA JSON responses — these can arrive WITHOUT the
  // SSE `data:` prefix when the WAF returns a plain JSON body (e.g. FAIL_SYS_USER_VALIDATE).
  // Normal SSE responses always have `data: ...` prefix; plain JSON means the upstream
  // was intercepted by the WAF before SSE streaming could begin.
  if (!trimmed.startsWith('data: ')) {
    let wafChunk: any;
    try {
      wafChunk = JSON.parse(trimmed);
    } catch {
      return; // not JSON, not SSE — skip
    }
    if (Array.isArray(wafChunk?.ret) && wafChunk.ret[0] === 'FAIL_SYS_USER_VALIDATE') {
      const detail = wafChunk.ret[1] || 'RGV587 captcha required';
      logStore.addError(ctx.logId, `Qwen WAF CAPTCHA (FAIL_SYS_USER_VALIDATE): ${detail}`);
      logStore.log('warn', 'qwen', `[Qwen] WAF CAPTCHA for ${ctx.resolvedEmail || '?'}: ${detail} (logId=${ctx.logId})`);
      if (ctx.resolvedEmail) throttleAccount(ctx.resolvedEmail, 5 * 60 * 1000);
      state.upstreamError = {
        message: `Qwen CAPTCHA required (WAF anti-bot): ${detail}`,
        code: 'waf_captcha',
        upstreamCode: 'FAIL_SYS_USER_VALIDATE',
      };
    }
    return;
  }

  const dataStr = trimmed.slice(6);
  if (dataStr === '[DONE]') return;
  let chunk: any;
  try {
    chunk = JSON.parse(dataStr);
  } catch (e) {
    console.error('[Chat] Non-streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
    return;
  }

  // Alibaba WAF CAPTCHA punishment — HTTP 200 SSE line shaped
  // {ret:["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."], data:{url:...}}.
  // Must be checked BEFORE the generic chunk.error branch (it has no .error).
  if (Array.isArray(chunk?.ret) && chunk.ret[0] === 'FAIL_SYS_USER_VALIDATE') {
    const detail = chunk.ret[1] || 'RGV587 captcha required';
    logStore.addError(ctx.logId, `Qwen WAF CAPTCHA (FAIL_SYS_USER_VALIDATE): ${detail}`);
    logStore.log('warn', 'qwen', `[Qwen] WAF CAPTCHA for ${ctx.resolvedEmail || '?'}: ${detail} (logId=${ctx.logId})`);
    // CAPTCHA is transient (WAF anti-bot), not a permanent account failure —
    // throttle so the account can recover, matching qwen.ts's CAPTCHA handling.
    if (ctx.resolvedEmail) throttleAccount(ctx.resolvedEmail, 5 * 60 * 1000);
    state.upstreamError = {
      message: `Qwen CAPTCHA required (WAF anti-bot): ${detail}`,
      code: 'waf_captcha',
      upstreamCode: 'FAIL_SYS_USER_VALIDATE',
    };
    return;
  }

  // Detect upstream Qwen SSE error payload mid-stream
  if (chunk.error) {
    const errMsg = typeof chunk.error === 'string' ? chunk.error : chunk.error.message || JSON.stringify(chunk.error);
    logStore.addError(ctx.logId, `Qwen upstream SSE error: ${errMsg}`);
    if (/RateLimited|daily usage limit/i.test(errMsg) && ctx.retrySignal) {
      ctx.retrySignal.needsRetry = true;
      ctx.retrySignal.failedEmail = ctx.resolvedEmail;
      if (ctx.resolvedEmail) setAccountDisabled(ctx.resolvedEmail, true);
      logStore.log('warn', 'qwen', `[Qwen] RateLimited via mid-stream SSE: disabled ${ctx.resolvedEmail} — ${errMsg}`);
    } else if (!ctx.retrySignal?.needsRetry) {
      // Non-RateLimited upstream error — surface it to the client instead of
      // returning a 200 stop with empty content.
      state.upstreamError = {
        message: errMsg,
        upstreamCode: typeof chunk.error === 'object' ? chunk.error?.code : undefined,
      };
    }
    return;
  }

  const deltaStatus = chunk.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    const deltaCode = chunk.choices?.[0]?.delta?.code;
    const deltaMsg = chunk.choices?.[0]?.delta?.message || '';
    logStore.addError(ctx.logId, `Qwen stream delta returned error status: code=${deltaCode} msg=${deltaMsg}`);
    if ((deltaCode === 'RateLimited' || /RateLimited|daily usage limit/i.test(deltaMsg)) && ctx.retrySignal) {
      ctx.retrySignal.needsRetry = true;
      ctx.retrySignal.failedEmail = ctx.resolvedEmail;
      if (ctx.resolvedEmail) setAccountDisabled(ctx.resolvedEmail, true);
      logStore.log('warn', 'qwen', `[Qwen] RateLimited via mid-stream delta: disabled ${ctx.resolvedEmail} — code=${deltaCode} msg=${deltaMsg}`);
    } else if (!ctx.retrySignal?.needsRetry) {
      // Non-RateLimited upstream error — surface it to the client instead of
      // returning a 200 stop with empty content.
      state.upstreamError = {
        message: deltaMsg || `Qwen stream delta returned error status (code=${deltaCode})`,
        code: deltaCode,
        upstreamCode: deltaCode,
      };
    }
    return;
  }

  if (chunk['response.created']?.response_id) {
    state.knownResponseIds.add(chunk['response.created'].response_id);
    state.nextParentId = chunk['response.created'].response_id;
  } else if (chunk.response_id) {
    state.knownResponseIds.add(chunk.response_id);
    state.nextParentId = chunk.response_id;
  }

  if (chunk.usage) {
    if (chunk.usage.output_tokens) state.completionTokens = chunk.usage.output_tokens;
    if (chunk.usage.input_tokens) state.promptTokens = chunk.usage.input_tokens;
  }

  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return;
  // Accept chunks from any response_id seen in this stream. Locking to the first
  // id dropped the answer phase whenever Qwen emitted think and answer under
  // different response_ids (multi-phase / tool-call turns).
  if (
    state.knownResponseIds.size > 0 &&
    chunk.response_id &&
    !state.knownResponseIds.has(chunk.response_id) &&
    !(chunk['response.created']?.response_id && state.knownResponseIds.has(chunk['response.created'].response_id))
  )
    return;

  if (delta.phase === 'think' || delta.phase === 'thinking_summary') {
    processThinkingDelta(delta, state);
  } else if (delta.phase === 'answer') {
    processAnswerDelta(delta, state, ctx);
  }
}

function flushAndDetectLoops(state: StreamProcessorState, ctx: NonStreamingContext): void {
  if (ctx.toolNonce && state.nonceToolStream) {
    const result = flushNonceToolStream(state.nonceToolStream);
    if (result.error) state.toolProtocolError = result.error;
    state.lastFullContent += result.content;
    if (result.toolCalls.length > 0) {
      processToolCallsThroughGuard(result.toolCalls, state.toolCallsOut, {
        logId: ctx.logId,
        toolSpamGuard: state.toolSpamGuard,
        correctionPrompts: state.correctionPrompts,
        maxToolCalls: MAX_TOOL_CALLS_PER_TURN,
        logParsed: true,
      });
    }
  }
  if (state.toolCallsOut.length < 3) return;
  const parsedForLoopCheck: ParsedToolCall[] = state.toolCallsOut.map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: (() => {
      try {
        return JSON.parse(tc.function.arguments);
      } catch {
        return {};
      }
    })(),
  }));
  const loopCheck = detectParallelToolLoop(parsedForLoopCheck);
  if (!loopCheck.ok) {
    logStore.log('debug', 'chat', `[🔄 PARALLEL LOOP] ${loopCheck.errors[0]}`);
    state.correctionPrompts.push(loopCheck.correctionPrompt);
    logStore.addError(ctx.logId, `Parallel loop: ${loopCheck.errors[0]}`);
    if (loopCheck.valid && loopCheck.valid.length < parsedForLoopCheck.length) {
      const validIds = new Set(loopCheck.valid.map((v) => v.id));
      state.toolCallsOut = state.toolCallsOut.filter((tc) => validIds.has(tc.id));
    }
  }
}

function buildResponseFromState(state: StreamProcessorState, ctx: NonStreamingContext): Response {
  const { c, logId, completionId, body, session } = ctx;
  const reasoningTokensEstimate = state.reasoningBuffer ? Math.ceil(state.reasoningBuffer.length / 4) : 0;
  const usage = {
    prompt_tokens: state.promptTokens,
    completion_tokens: state.completionTokens,
    total_tokens: state.promptTokens + state.completionTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokensEstimate },
    prompt_tokens_details: { cached_tokens: 0 },
  };
  const contentForUser = state.lastFullContent;
  state.lastFullContent = contentForUser;
  const { cleanText: baseFilteredContent, thinking: filteredReasoning } = { cleanText: state.lastFullContent, thinking: '' };
  if (filteredReasoning) {
    state.reasoningBuffer = state.reasoningBuffer ? state.reasoningBuffer + '\n' + filteredReasoning : filteredReasoning;
  }
  const filteredContent = baseFilteredContent;
  const message: any = { role: 'assistant', content: state.toolCallsOut.length ? null : filteredContent };
  if (state.reasoningBuffer) message.reasoning_content = state.reasoningBuffer;
  if (state.toolCallsOut.length) {
    // Align each tool call's arg names to the client-registered schema so
    // camelCase clients get camelCase keys (and snake_case clients get snake).
    state.toolCallsOut.forEach((tc) => {
      try {
        const parsed = JSON.parse(tc.function.arguments);
        tc.function.arguments = JSON.stringify(alignArgsToSchema(tc.function.name, parsed, body.tools));
      } catch {
        /* keep as-is */
      }
    });
    state.toolCallsOut.forEach((tc, idx) => (tc.index = idx));
    message.tool_calls = state.toolCallsOut;
  }
  logStore.updateEntry(logId, (entry) => {
    const now = Date.now();
    const startedAt = new Date(entry.timestamp).getTime();
    if (startedAt) entry.latency_ms = now - startedAt;
    entry.finalResponse = {
      finishReason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
      toolCallCount: state.toolCallsOut.length,
      contentPreview: state.lastFullContent.length > 500 ? state.lastFullContent.substring(0, 500) + '...' : state.lastFullContent,
    };
    entry.rawFullContent = state.lastFullContent;
    entry.remainingText = state.lastFullContent;
  });
  for (const prompt of state.correctionPrompts) {
    logStore.addError(logId, prompt);
  }
  logStore.addProcessedOutput(logId, filteredContent);
  if (state.correctionPrompts.length > 0) {
    pendingCorrections.set(session.chatId, [...state.correctionPrompts]);
  }
  return c.json({
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    system_fingerprint: 'fp_qwen_gate',
    service_tier: 'default',
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: state.toolCallsOut.length ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  });
}

async function processContentChunks(state: StreamProcessorState, ctx: NonStreamingContext): Promise<Response> {
  const { c, logId, resolvedEmail, retrySignal } = ctx;
  // Non-RateLimited upstream error captured mid-stream by parseQwenResponse.
  // The SSE line was consumed during the read loop so parseQwenErrorPayload(buffer)
  // can't see it — emit a real error response instead of a 200 stop with empty content.
  if (state.upstreamError) {
    const upstreamError = state.upstreamError;
    logStore.log('warn', 'qwen', `[Qwen] Upstream error in non-streaming response: ${upstreamError.message} (logId=${logId})`);
    // WAF/RateLimited: signal retry so the caller can switch accounts
    if (upstreamError.upstreamCode === 'FAIL_SYS_USER_VALIDATE' && resolvedEmail) {
      if (retrySignal) {
        retrySignal.needsRetry = true;
        retrySignal.failedEmail = resolvedEmail;
      }
      throttleAccount(resolvedEmail, 5 * 60 * 1000);
    }
    if (upstreamError.upstreamCode === 'RateLimited' && resolvedEmail && retrySignal) {
      retrySignal.needsRetry = true;
      retrySignal.failedEmail = resolvedEmail;
    }
    logStore.finalizeRequest(logId);
    return c.json(
      {
        error: {
          message: cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message,
          type: 'upstream_error',
          code: upstreamError.code,
          upstream_code: upstreamError.upstreamCode,
        },
      },
      upstreamError.status ?? 502,
    );
  }
  const upstreamError = parseQwenErrorPayload(state.buffer);
  if (upstreamError) {
    // For RateLimited, signal retry so the caller can switch accounts
    if (upstreamError.upstreamCode === 'RateLimited' && resolvedEmail) {
      if (retrySignal) {
        retrySignal.needsRetry = true;
        retrySignal.failedEmail = resolvedEmail;
      }
      setAccountDisabled(resolvedEmail, true);
      logStore.log('warn', 'qwen', `[Qwen] RateLimited via non-streaming flush: disabled ${resolvedEmail} and switching account — ${upstreamError.message}`);
    }
    // FAIL_SYS_USER_VALIDATE (RGV587 WAF) — retryable, switch accounts
    if (upstreamError.upstreamCode === 'FAIL_SYS_USER_VALIDATE' && resolvedEmail) {
      if (retrySignal) {
        retrySignal.needsRetry = true;
        retrySignal.failedEmail = resolvedEmail;
      }
      throttleAccount(resolvedEmail, 5 * 60 * 1000);
      logStore.log('warn', 'qwen', `[Qwen] WAF CAPTCHA via non-streaming flush: throttled ${resolvedEmail} and switching account — ${upstreamError.message}`);
    }
    logStore.finalizeRequest(logId);
    return c.json(
      {
        error: {
          message: cleanTextOfXmlArtifacts(upstreamError.message).cleanedText || upstreamError.message,
          type: 'upstream_error',
          code: upstreamError.code,
          upstream_code: upstreamError.upstreamCode,
          upstream_status: upstreamError.status,
        },
      },
      upstreamError.status,
    );
  }
  flushAndDetectLoops(state, ctx);
  if (state.toolProtocolError) {
    const message = state.toolProtocolError;
    logStore.addError(logId, `Tool protocol error: ${message}`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'tool_protocol_error';
    });
    logStore.finalizeRequest(logId);
    return c.json({ error: { message, type: 'upstream_error', code: 'tool_protocol_error' } }, 502);
  }
  // WAF diag: dump buffer contents when empty response detected or stream is suspiciously short
  if (!state.lastFullContent || state.buffer) {
    logStore.log('debug', 'qwen', `[Qwen] Non-stream buffer: lastContent=${state.lastFullContent?.length || 0} chars, toolCalls=${state.toolCallsOut.length}, bufLen=${state.buffer.length}, buf="${state.buffer.substring(0, 500)}" (logId=${logId})`);
  }

  // Upstream ended normally ([DONE] / finished) but produced zero answer
  // content and zero tool calls — the non-streaming counterpart of the streaming
  // "empty stream" guard in streamLoop.ts. reasoning_content is internal
  // deliberation, not a user-facing answer, so a thinking-only turn with an
  // empty answer is still a failed turn. Returning it as a clean `stop` shows the
  // user an empty reply and makes the client think the task completed. Surface
  // it as an explicit error so downstream retries.
  if (!state.lastFullContent && state.toolCallsOut.length === 0) {
    const emptyMsg = 'Upstream returned an empty response (no content, no tool calls)';
    logStore.log('warn', 'qwen', `[Qwen] ${emptyMsg} (logId=${logId})`);
    // Diagnostic: snapshot the recent upstream network entries + buffer so a
    // 200-empty vs mid-stream-drop vs no-connection case can be told apart.
    dumpUpstreamDiagnostics({
      logId,
      accountEmail: resolvedEmail,
      model: ctx.body.model,
      stream: false,
      trigger: 'nonstream_empty',
      bufferSnippet: state.buffer,
    });
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'upstream_empty';
    });
    logStore.finalizeRequest(logId);
    return c.json({ error: { message: emptyMsg, type: 'upstream_error', code: 'upstream_empty' } }, 502);
  }
  const response = buildResponseFromState(state, ctx);
  logStore.finalizeRequest(logId);
  return response;
}

export async function handleNonStreamingRequest(ctx: NonStreamingContext): Promise<Response> {
  const { session, sessionHeaders, resolvedEmail } = ctx;
  const state = buildQwenRequest(ctx);
  let logFinalized = false;
  let result: Response | null = null;
  try {
    while (true) {
      const { done, value } = await state.reader.read();
      if (done) {
        // WAF may return plain JSON in a single chunk with done=true.
        // Process the final chunk before breaking.
        if (value) {
          state.buffer += state.decoder.decode(value, { stream: true });
          const finalLines = state.buffer.split('\n');
          for (const line of finalLines) {
            parseQwenResponse(line, state, ctx);
          }
        }
        break;
      }
      state.buffer += state.decoder.decode(value, { stream: true });
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';
      for (const line of lines) {
        parseQwenResponse(line, state, ctx);
      }
      // Early termination: if RateLimited was detected mid-stream, stop reading
      // the remaining data. The caller will check retrySignal and retry.
      if (ctx.retrySignal?.needsRetry) {
        logStore.log('info', 'chat', `[Chat] Non-streaming early termination: RateLimited detected on ${resolvedEmail}`);
        break;
      }
    }
    result = await processContentChunks(state, ctx);
    logFinalized = true;
    return result;
  } finally {
    if (!logFinalized) logStore.finalizeRequest(ctx.logId);
    try {
      state.reader.cancel();
    } catch {
      /* reader already cancelled */
    }
    try {
      state.reader.releaseLock();
    } catch {
      /* reader already cancelled */
    }
    // Release session with correct success flag based on actual response status
    // (false for 429 RateLimited, true for successful responses)
    const isSuccess = result ? result.ok : false;
    sessionPool.release(session.chatId, state.nextParentId, sessionHeaders, resolvedEmail, isSuccess);
  }
}

export function buildChatUpstreamErrorResponse(err: any): { body: any; status: number } {
  if (err?.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err?.message || '')) {
    // Accounts auto-disabled + switched internally; when all are exhausted this
    // surfaces as an api_error (502) so the downstream treats it as a transient
    // API failure and re-requests, rather than a permanent rate limit it waits on.
    return {
      body: {
        error: {
          message: 'All accounts have reached their daily usage limit. Please try again later.',
          type: 'api_error',
          code: 'api_error',
          upstream_message: err?.message,
          upstream_code: err?.upstreamCode,
          upstream_status: err?.upstreamStatus || 429,
        },
      },
      status: 502,
    };
  }
  return buildUpstreamErrorResponse(err, err?.upstreamStatus || 500);
}

/** Wrap an OpenAI-format error body into Anthropic's error envelope so
 *  Claude Code (`/v1/messages`) correctly surfaces it as a failed request. */
export function wrapAsAnthropicError(body: any): any {
  if (body?.error) {
    const wrapped: any = {
      type: 'error',
      error: {
        type: body.error.type || 'api_error',
        message: body.error.message || 'Upstream error',
        code: body.error.code || null,
      },
    };
    if (body.error.upstream_code !== undefined) wrapped.error.upstream_code = body.error.upstream_code;
    if (body.error.upstream_status !== undefined) wrapped.error.upstream_status = body.error.upstream_status;
    return wrapped;
  }
  return body;
}
