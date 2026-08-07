import { logStore } from '../services/logStore.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import type { ParsedToolCall } from '../types/openai.ts';
import { consumeNonceToolChunk, createNonceToolStreamState, type NonceToolStreamState } from '../tools/nonceToolStream.ts';
import { filterContent } from '../utils/contentFilter.ts';
import { THINK_TAG_NAMES } from '../utils/tagNames.ts';
import {
  type AmplificationGuardState,
  cleanThinkTags,
  extractDeltaContent,
  normalizeAnswerChunk,
  type AnswerChunkMode,
} from './chatHelpers.ts';

import { writeContentDelta, writeReasoningEvent, writeToolCallEvent } from './writeHelpers.ts';

// ── Constants ──────────────────────────────────────────────────────

/**
 * Matches self-closing thinking/tool tags (newlines/spaces around tags).
 * Performance: extracted to module-level const to avoid recompilation on each chunk.
 */
const SELF_CLOSING_TAG_PATTERN = new RegExp(`^[\\n\\s]*<\\/?(?:${THINK_TAG_NAMES.join('|')})[\\s>]*[\\n\\s]*$`);

// ── Local MCP tool call extraction (from Qwen Studio local_tool phase) ──

/**
 * Extract tool calls from SSE data containing `extra.local_mcp` in the delta.
 * Qwen Studio sends tool calls in this format during the `local_tool` phase:
 *
 * ```json
 * {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "local_tool",
 *   "status": "finished",
 *   "extra": {"local_mcp": {"★": [{"tool_name": "★-bash", "params": {"command": "ls -la /tmp"}}]}}}}]}
 * ```
 *
 * @param sseData - Parsed SSE data chunk
 * @returns Array of ParsedToolCall with UUID call IDs
 */
export function extractLocalMcpToolCalls(sseData: any): ParsedToolCall[] {
  const localMcp = sseData?.choices?.[0]?.delta?.extra?.local_mcp;
  if (!localMcp) return [];

  const serverTools = localMcp['★'] || localMcp.star;
  if (!Array.isArray(serverTools)) return [];

  const toolCalls: ParsedToolCall[] = [];
  for (const tool of serverTools) {
    if (tool?.tool_name && tool?.params !== undefined) {
      const rawName = String(tool.tool_name);
      const name = rawName.replace(/^[^A-Za-z0-9]+-?/, '');
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name,
        arguments: tool.params,
      });
    }
  }
  return toolCalls;
}

// ── Per-chunk stream processing ────────────────────────────────────

export interface StreamProcessingState {
  knownResponseIds: Set<string>;
  nextParentId: string | null;
  completionTokens: number;
  promptTokens: number;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  lastRawContent: string;
  lastVStrRaw: string;
  answerChunkMode?: AnswerChunkMode;
  /** Request-specific nonce envelope parser state. Present only in nonce mode. */
  nonceToolStream?: NonceToolStreamState;
  /** Protocol failure captured mid-stream and surfaced as an SSE error at completion. */
  toolProtocolError?: string;
}

export interface StreamProcessingCtx {
  streamWriter: any;
  completionId: string;
  model: string;
  emittedToolCallCount: number;
  enableContentFiltering: boolean;
  cleanOutput: boolean;
  logId: string;
  resolvedEmail: string;
  ampState: AmplificationGuardState;
  qwenAbortController: AbortController;
  qwenLogFile?: string;
  sseEventCount?: number;
  /** Same nonce that was injected into this request's prompt. */
  toolNonce?: string;
  /** Full client tool schemas used for strict envelope validation. */
  clientTools?: any[];
  /** Non-rate-limit upstream failure consumed from the SSE stream. */
  streamError?: { message: string; type?: string; code?: string; upstreamCode?: string };
  /** Existing account-rotation hook used by mid-stream RateLimited handling. */
  retryWithNewAccount?: (email: string) => void;
}

export type ProcessStreamResult = 'continue' | 'break_stream' | 'retry_account';

/**
 * Shared content filter pipeline standardizing the order:
 * cleanTextOfXmlArtifacts → filterContent → cleanThinkTags.
 * Used in both per-chunk (processStreamData) and flush (handlePostStreamCompletion) paths.
 */
export function filterContentPipeline(
  text: string,
  enableContentFiltering: boolean,
  /** Set true for per-chunk deltas to avoid mangling partial XML tool call syntax.
   *  Skips cleanTextOfXmlArtifacts and filterContent (both strip incomplete
   *  XML tags and create orphaned tail fragments). Only runs cleanThinkTags
   *  which strips complete tags safely. Full XML stripping happens on flush. */
  skipXmlArtifactStripping?: boolean,
): { cleanText: string | null; thinking: string } {
  if (!text) return { cleanText: null, thinking: '' };
  if (skipXmlArtifactStripping) {
    // Per-chunk: only strip complete think/function tags. Partial XML tool call
    // syntax (e.g. "<function" or "=read>\n" split across chunks) is handled
    // on the full accumulated text during flush processing.
    const cleaned = cleanThinkTags(text);
    return { cleanText: cleaned || null, thinking: '' };
  }
  // Full-text processing (flush path): strip ALL XML tool call artifacts.
  const { cleanedText: stripped } = cleanTextOfXmlArtifacts(text);
  if (!enableContentFiltering) {
    const cleaned = cleanThinkTags(stripped);
    return { cleanText: cleaned || null, thinking: '' };
  }
  const filtered = filterContent(stripped);
  const cleaned = cleanThinkTags(filtered.cleanText);
  return {
    cleanText: cleaned || null,
    thinking: filtered.thinking || '',
  };
}

/**
 * Process a single parsed SSE data chunk from the stream.
 * Mutates `state` in place and returns a directive:
 *   - 'continue'      → normal processing, keep iterating
 *   - 'break_stream'  → stream finished (break out of loops)
 */
export async function processStreamData(data: any, state: StreamProcessingState, ctx: StreamProcessingCtx): Promise<ProcessStreamResult> {
  const { streamWriter, completionId, model, enableContentFiltering, logId, resolvedEmail, ampState } = ctx;

  // Check for upstream Qwen error sent as SSE data chunk
  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
    const upstreamCode = typeof data.error === 'object' ? data.error?.code : undefined;
    logStore.addError(logId, `Qwen upstream SSE error: ${errMsg}`);
    if (upstreamCode === 'RateLimited' || /RateLimited|daily usage limit/i.test(errMsg)) {
      ctx.retryWithNewAccount?.(resolvedEmail);
      return 'retry_account';
    }
    ctx.streamError = { message: errMsg, code: upstreamCode, upstreamCode };
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    return 'break_stream';
  }
  const deltaStatus = data.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    const delta = data.choices[0].delta;
    const errMsg = delta.message || `Qwen stream delta returned error status${delta.code ? ` (${delta.code})` : ''}`;
    logStore.addError(logId, errMsg);
    if (delta.code === 'RateLimited' || /RateLimited|daily usage limit/i.test(errMsg)) {
      ctx.retryWithNewAccount?.(resolvedEmail);
      return 'retry_account';
    }
    ctx.streamError = { message: errMsg, code: delta.code, upstreamCode: delta.code };
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    return 'break_stream';
  }
  let streamFinished = false;
  if (deltaStatus === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    // local_mcp is intentionally disabled: it triggers Qwen WAF and is not
    // bound to this request's nonce. Never execute calls from that channel.
    if (deltaPhase === 'local_tool') {
      ctx.streamError = {
        message: 'Qwen returned the disabled local_mcp tool protocol.',
        code: 'tool_protocol_error',
        upstreamCode: 'local_mcp',
      };
      return 'break_stream';
    }
    // Don't break on think-phase finished — with thinking_format=full,
    // answer content arrives in a separate answer phase after think completes.
    // For all other phases, mark as finished but still run content extraction:
    // content may be bundled in the same SSE event as the finished status.
    if (deltaPhase !== 'thinking_summary' && deltaPhase !== 'think') {
      streamFinished = true;
      // Fall through to content extraction so content in finished chunk isn't lost
    }
  }

  // Track SSE events for logging
  ctx.sseEventCount = (ctx.sseEventCount || 0) + 1;

  if (data['response.created']?.response_id) {
    state.knownResponseIds.add(data['response.created'].response_id);
    state.nextParentId = data['response.created'].response_id;
  } else if (data.response_id) {
    state.knownResponseIds.add(data.response_id);
    state.nextParentId = data.response_id;
  }

  if (data.usage) {
    if (data.usage.output_tokens) state.completionTokens = data.usage.output_tokens;
    if (data.usage.input_tokens) state.promptTokens = data.usage.input_tokens;
  }

  const deltaResult = extractDeltaContent(data, state.knownResponseIds, state.currentThoughtIndex, state.reasoningBuffer);
  const { vStr, foundStr, isThinkingChunk } = deltaResult;
  state.currentThoughtIndex = deltaResult.currentThoughtIndex;

  if (!foundStr || vStr === '') return 'continue';
  if (vStr === 'FINISHED') return 'continue';

  if (isThinkingChunk) {
    if (state.reasoningBuffer.length < 20000) state.reasoningBuffer += vStr;
    // Write thinking content immediately for real-time reasoning_content streaming.
    // Clean XML artifacts to avoid leaking partial tool call syntax into reasoning (the
    // deferred flush was removed to prevent duplicate emission — every chunk is written once).
    if (vStr) {
      const cleaned = cleanTextOfXmlArtifacts(vStr).cleanedText;
      if (cleaned) {
        await writeReasoningEvent(streamWriter, completionId, model, cleaned);
      }
    }
    return 'continue';
  }

  if (SELF_CLOSING_TAG_PATTERN.test(vStr)) {
    return 'continue';
  }

  logStore.addRawChunk(logId, vStr);

  // Compute incremental delta for text content tracking
  let rawText = vStr;
  const normalized = normalizeAnswerChunk(vStr, state.lastVStrRaw, state.answerChunkMode || 'unknown');
  rawText = normalized.delta;
  state.lastVStrRaw = normalized.previousChunk;
  state.answerChunkMode = normalized.mode;

  // Nonce mode has an unambiguous protocol. Release only bytes that cannot
  // become this request's exact opener; once opened, withhold the entire
  // envelope until strict parsing succeeds.
  if (ctx.toolNonce) {
    state.nonceToolStream ??= createNonceToolStreamState();
    const result = consumeNonceToolChunk(state.nonceToolStream, rawText, ctx.toolNonce, ctx.clientTools);
    if (result.error) {
      state.toolProtocolError = result.error;
      logStore.addError(logId, `Tool protocol error: ${result.error}`);
      return 'break_stream';
    }

    if (result.content) {
      state.lastRawContent += result.content;
      state.lastFullContent += result.content;
      await writeContentDelta(
        streamWriter,
        completionId,
        model,
        result.content,
        ampState,
        logId,
        resolvedEmail,
        state.lastRawContent,
        state.lastVStrRaw,
        logStore,
      );
    }

    if (result.toolCalls.length > 0) {
      logStore.updateEntry(logId, (entry) => {
        for (const tc of result.toolCalls) entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
      for (const [i, tc] of result.toolCalls.entries()) {
        await writeToolCallEvent(streamWriter, completionId, model, tc, ctx.emittedToolCallCount + i);
      }
      ctx.emittedToolCallCount += result.toolCalls.length;
    }
    return streamFinished ? 'break_stream' : 'continue';
  }

  // Requests without registered tools have no in-band protocol. Preserve answer
  // bytes exactly instead of applying XML heuristics to code, diffs, or markup.
  state.lastRawContent += rawText;
  state.lastFullContent += rawText;
  if (rawText) {
    await writeContentDelta(
      streamWriter,
      completionId,
      model,
      rawText,
      ampState,
      logId,
      resolvedEmail,
      state.lastRawContent,
      state.lastVStrRaw,
      logStore,
    );
  }
  return streamFinished ? 'break_stream' : 'continue';
}
