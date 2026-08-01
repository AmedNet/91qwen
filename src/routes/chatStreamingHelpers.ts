import { logStore } from '../services/logStore.ts';
import { setAccountDisabled } from '../services/accountManager.ts';
import { logQwenSSE } from '../services/qwenLogger.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed, alignArgsToSchema, CANONICAL_PARAM_NAMES, camelToSnake, PARAM_NAME_FIXUPS as XML_PARAM_NAME_FIXUPS } from '../tools/xmlToolParser.ts';
import type { ParsedToolCall } from '../types/openai.ts';
import { filterContent } from '../utils/contentFilter.ts';
import { THINK_TAG_NAMES, TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';
import {
  type AmplificationGuardState,
  cleanThinkTags,
  detectCumulativeChunk,
  extractDeltaContent,
  getSnapshotDelta,
} from './chatHelpers.ts';

import { writeContentDelta, writeReasoningEvent, writeToolCallEvent } from './writeHelpers.ts';

// ── Constants ──────────────────────────────────────────────────────

/**
 * Matches self-closing thinking/tool tags (newlines/spaces around tags).
 * Performance: extracted to module-level const to avoid recompilation on each chunk.
 */
const SELF_CLOSING_TAG_PATTERN = new RegExp(`^[\\n\\s]*<\\/?(?:${THINK_TAG_NAMES.join('|')})[\\s>]*[\\n\\s]*$`);

/**
 * Maximum accumulated buffer size for the one-chunk delay approach.
 * If a chunk has `<` without `>` and the accumulated (pending + current) text exceeds
 * this length, we force-release it as regular content instead of continuing to buffer.
 * Prevents indefinite buffering of `<` in non-XML text like "x < 3" across many chunks.
 * 200 chars is generous: the longest possible tool call tag start
 * (e.g. `<parameter=` + longest param name) fits easily, while non-XML `<` usage
 * would accumulate well beyond 200 chars before the stream emits any content.
 */
const MAX_BUFFER_CHARS = 200;

/**
 * Maximum depth for tool call nesting. Prevents runaway depth from
 * unbalanced tags (e.g. two opens and one close) from permanently
 * suppressing content. Capped at 5 — realistic maximum for parallel
 * tool calls (Qwen doesn't nest, but safety first).
 */
const MAX_TOOL_CALL_DEPTH = 5;

/**
 * When toolCallDepth > 0 but no new `<function=` open tag appears for this
 * many consecutive chunks, force-reset depth to 0. This prevents permanent
 * content suppression when `</function>` never arrives (e.g. truncated stream).
 * 20 chunks at ~50ms each ≈ 1 second of streaming without a close tag.
 */
const CHUNK_STUCK_THRESHOLD = 20;


/**
 * Loop detection: if the last N content chunks are near-identical, the model
 * is stuck in a repetition loop (observed with qwen3.7-plus thinking phase).
 */
const LOOP_WINDOW = 6;
const LOOP_MIN_CHARS = 30;
const LOOP_SIMILARITY = 0.85;

function chunkSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (Math.max(a.length, b.length) / Math.min(a.length, b.length) > 3) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  let matches = 0;
  const longerChars = new Map<string, number>();
  for (const ch of longer) longerChars.set(ch, (longerChars.get(ch) || 0) + 1);
  for (const ch of shorter) {
    const count = longerChars.get(ch) || 0;
    if (count > 0) { matches++; longerChars.set(ch, count - 1); }
  }
  return (2 * matches) / (a.length + b.length);
}

/**
 * Returns the length of the longest common prefix between two strings
 * (character-by-character comparison). Used as a secondary loop signal:
 * genuine repetition almost always shares a significant prefix,
 * while Chinese text with coincidental character-bag overlap won't.
 */
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

/**
 * Returns the count of identical lines (after trimming) shared between
 * two chunks. Genuine loops produce identical lines; coincidental
 * character-bag similarity from Chinese text won't.
 */
function sharedLineCount(a: string, b: string): number {
  const linesA = new Set(a.split('\n').map(l => l.trim()).filter(l => l.length > 5));
  const linesB = b.split('\n').map(l => l.trim()).filter(l => l.length > 5);
  let count = 0;
  for (const line of linesB) {
    if (linesA.has(line)) count++;
  }
  return count;
}

function detectLoop(recentChunks: string[]): boolean {
  if (recentChunks.length < LOOP_WINDOW) return false;
  const window = recentChunks.slice(-LOOP_WINDOW);
  if (window.some(c => c.length < LOOP_MIN_CHARS)) return false;
  const ref = window[0];
  let similarCount = 0;
  for (let i = 1; i < window.length; i++) {
    const sim = chunkSimilarity(ref, window[i]);
    if (sim >= LOOP_SIMILARITY) {
      // Secondary check: genuine loops share a significant prefix OR
      // share at least 1 identical line. This filters out Chinese text
      // where character-bag similarity can be high from shared
      // grammatical particles (的, 是, 了, etc.) despite different semantics.
      const prefix = commonPrefixLen(ref, window[i]);
      const sharedLines = sharedLineCount(ref, window[i]);
      if (prefix >= 15 || sharedLines >= 1) {
        similarCount++;
      }
    }
  }
  return similarCount >= LOOP_WINDOW - 2;
}

/** Deterministic JSON serialization (sorted keys) for dedup comparison. */
function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map(k =>
    JSON.stringify(k) + ':' + canonicalJson((obj as Record<string, unknown>)[k])
  ).join(',') + '}';
}

/**
 * Qwen models sometimes forget underscores in snake_case parameter names
 * (e.g. "filepath" instead of "file_path"). This map re-canonicalizes
 * known mistakes in local_mcp tool parameters before emission.
 * Mirrors PARAM_NAME_FIXUPS in xmlToolParser.ts for the XML path.
 * Uses the imported XML_PARAM_NAME_FIXUPS as base, extended with local_mcp-specific entries.
 */
const LOCAL_MCP_PARAM_FIXUPS: Record<string, string> = {
  ...XML_PARAM_NAME_FIXUPS,
};

function fixupLocalMcpArgs(params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params !== 'object') return params;
  const fixed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const lowered = k.toLowerCase();
    // 1. Direct fixup lookup first
    const direct = LOCAL_MCP_PARAM_FIXUPS[lowered];
    if (direct) { fixed[direct] = v; continue; }
    // 2. camelCase → snake_case (e.g. "outputMode" → "output_mode")
    const snaked = camelToSnake(k);
    if (snaked !== lowered) {
      const snakedFixed = LOCAL_MCP_PARAM_FIXUPS[snaked.toLowerCase()];
      if (snakedFixed) { fixed[snakedFixed] = v; continue; }
      for (const canonical of CANONICAL_PARAM_NAMES) {
        if (canonical === snaked) { fixed[canonical] = v; break; }
      }
      if (fixed[snaked]) continue;
    }
    // 3. Fuzzy match: normalize by removing underscores and compare
    const normalized = lowered.replace(/_/g, '');
    let found = false;
    for (const canonical of CANONICAL_PARAM_NAMES) {
      if (canonical.toLowerCase().replace(/_/g, '') === normalized) {
        fixed[canonical] = v;
        found = true;
        break;
      }
    }
    if (!found) {
      // 4. If snaked version differs from original, prefer snaked
      fixed[snaked !== lowered ? snaked : k] = v;
    }
  }
  return fixed;
}

// ── Local MCP tool call extraction (from Qwen Studio local_tool phase) ──

/**
 * Extract tool calls from SSE data containing `extra.local_mcp` in the delta.
 * Qwen Studio sends tool calls in this format during the `local_tool` phase:
 *
 * ```json
 * {"choices": [{"delta": {"role": "assistant", "content": "", "phase": "local_tool",
 *   "status": "finished",
 *   "extra": {"local_mcp": {"�?: [{"tool_name": "�?bash", "params": {"command": "ls -la /tmp"}}]}}}}]}
 * ```
 *
 * @param sseData - Parsed SSE data chunk
 * @returns Array of ParsedToolCall with UUID call IDs
 */
export function extractLocalMcpToolCalls(sseData: any): ParsedToolCall[] {
  const localMcp = sseData?.choices?.[0]?.delta?.extra?.local_mcp;
  if (!localMcp || typeof localMcp !== 'object') return [];

  const serverTools = Object.values(localMcp).find(Array.isArray) as any[] | undefined;
  if (!Array.isArray(serverTools)) return [];

  const toolCalls: ParsedToolCall[] = [];
  for (const tool of serverTools) {
    if (tool?.tool_name && tool?.params !== undefined) {
      const rawName = String(tool.tool_name);
      const name = rawName.replace(/^[^A-Za-z0-9]+-?/, '');
      toolCalls.push({
        id: `call_${crypto.randomUUID()}`,
        name,
        arguments: fixupLocalMcpArgs(tool.params),
      });
    }
  }
  return toolCalls;
}

// ── Per-chunk stream processing ────────────────────────────────────

export interface StreamProcessingState {
  targetResponseId: string | null;
  nextParentId: string | null;
  completionTokens: number;
  promptTokens: number;
  currentThoughtIndex: number;
  reasoningBuffer: string;
  lastFullContent: string;
  lastRawContent: string;
  lastFilteredSnapshot: string;
  lastThinkingSnapshot: string;
  lastVStrRaw: string;
  lastFilteredFullContent: string;
  lastDeltaThinkingFull: string;
  loggedToolCalls: Set<string>;
  lastParsePosition: number;
  /** Depth tracking for nested tool call XML blocks. >0 means suppress content emission. */
  toolCallDepth: number;
  /**
   * Chunk counter since the last `<function=` open tag was seen.
   * When toolCallDepth > 0 but no new open tag appears for CHUNK_STUCK_THRESHOLD
   * consecutive chunks, the depth counter is force-reset to 0.
   * This prevents permanent content suppression when `</function>` never arrives
   * (e.g. model output was truncated mid-tool-call).
   */
  chunksSinceLastTagOpen: number;
  /**
   * One-chunk buffer for handling XML tag splits across SSE chunk boundaries.
   * When a chunk contains `<` without `>`, it might be a tag split (e.g. `<func` + `tion=read>`).
   * We buffer the incomplete chunk and wait for the next chunk. If combining them completes a
   * known tool call tag, toolCallDepth suppresses content emission. If not, the combined text
   * is regular content and is emitted normally. Max buffer size prevents indefinite buffering
   * of `<` in non-XML text (e.g. "x < 3").
   */
  pendingChunk: string;
  /** Sliding window of recent content chunks for loop detection. */
  recentChunks: string[];
  /** Count of consecutive chunks detected as repetitive. */
  loopStreak: number;
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
  /** Client-registered tool schemas; used to align tool-call arg names to the schema's casing. */
  tools?: any[];
  /** Callback to signal that mid-stream error requires account retry. */
  retryWithNewAccount: (failedEmail: string) => void;
  /** Set when processStreamData catches a non-RateLimited upstream error mid-stream
   *  (e.g. quota_limit). handlePostStreamCompletion reads this to emit a real error
   *  event instead of a clean finish_reason:stop that masks the failure. */
  streamError?: { message: string; code?: string; upstreamCode?: string };
}

export type ProcessStreamResult = 'continue' | 'break_stream' | 'retry_account';

/**
 * Shared content filter pipeline standardizing the order:
 * cleanTextOfXmlArtifacts �?filterContent �?cleanThinkTags.
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
 *   - 'continue'      �?normal processing, keep iterating
 *   - 'break_stream'  �?stream finished (break out of loops)
 */
export async function processStreamData(data: any, state: StreamProcessingState, ctx: StreamProcessingCtx): Promise<ProcessStreamResult> {
  const { streamWriter, completionId, model, enableContentFiltering, logId, resolvedEmail, ampState } = ctx;

  // Check for upstream Qwen error sent as SSE data chunk
  if (data.error) {
    const errMsg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
    logStore.addError(logId, `Qwen upstream SSE error: ${errMsg}`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    // RateLimited: permanently disable account, then signal retry to switch accounts
    if (/RateLimited|rate.limit|upper limit|daily usage/i.test(errMsg) && resolvedEmail) {
      setAccountDisabled(resolvedEmail, true);
      ctx.retryWithNewAccount(resolvedEmail);
      logStore.log('warn', 'qwen', `[Qwen] RateLimited via SSE: disabled ${resolvedEmail} and switching account — ${errMsg}`);
      return 'retry_account';
    }
    // Non-RateLimited upstream error (quota_limit etc.): carry it forward so
    // handlePostStreamCompletion emits a real error event instead of stop.
    ctx.streamError = {
      message: errMsg,
      upstreamCode: typeof data.error === 'object' ? data.error?.code : undefined,
    };
    return 'break_stream';
  }
  const deltaStatus = data.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    logStore.addError(logId, `Qwen stream delta returned error status`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    // RateLimited: permanently disable account, then signal retry to switch accounts
    const deltaCode = data.choices?.[0]?.delta?.code;
    const deltaMsg = data.choices?.[0]?.delta?.message || '';
    if ((deltaCode === 'RateLimited' || /RateLimit|rate.limit|upper limit|daily usage/i.test(deltaMsg)) && resolvedEmail) {
      setAccountDisabled(resolvedEmail, true);
      ctx.retryWithNewAccount(resolvedEmail);
      logStore.log('warn', 'qwen', `[Qwen] RateLimited via delta status: disabled ${resolvedEmail} and switching account — code=${deltaCode} msg=${deltaMsg}`);
      return 'retry_account';
    }
    // Non-RateLimited upstream error: carry it forward for a real error event.
    ctx.streamError = {
      message: deltaMsg || 'Qwen stream delta returned error status',
      code: deltaCode,
      upstreamCode: deltaCode,
    };
    return 'break_stream';
  }
  let streamFinished = false;
  if (deltaStatus === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    // Always extract and emit local MCP tool calls before breaking
    if (deltaPhase === 'local_tool') {
      const localToolCalls = extractLocalMcpToolCalls(data);
      const newToolCalls = localToolCalls.filter((tc) => {
        const key = `${tc.name}:${canonicalJson(tc.arguments)}`;
        if (state.loggedToolCalls.has(key)) return false;
        state.loggedToolCalls.add(key);
        return true;
      });

      if (newToolCalls.length > 0) {
        logStore.updateEntry(logId, (entry) => {
          for (const tc of newToolCalls) {
            entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
          }
        });
        for (let i = 0; i < newToolCalls.length; i++) {
          newToolCalls[i].arguments = alignArgsToSchema(
            newToolCalls[i].name,
            newToolCalls[i].arguments as Record<string, unknown>,
            ctx.tools,
          );
          await writeToolCallEvent(streamWriter, completionId, model, newToolCalls[i], ctx.emittedToolCallCount + i);
        }
        ctx.emittedToolCallCount += newToolCalls.length;
      }
      if (ctx.qwenLogFile && localToolCalls.length > 0) {
        logQwenSSE(ctx.qwenLogFile, ctx.sseEventCount || 0, localToolCalls.length, localToolCalls);
      }
    }
    // Don't break on think-phase finished �?with thinking_format=full,
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
    if (!state.targetResponseId) state.targetResponseId = data['response.created'].response_id;
    state.nextParentId = data['response.created'].response_id;
  } else if (data.response_id && !state.targetResponseId) {
    state.targetResponseId = data.response_id;
    state.nextParentId = data.response_id;
  }

  if (data.usage) {
    if (data.usage.output_tokens) state.completionTokens = data.usage.output_tokens;
    if (data.usage.input_tokens) state.promptTokens = data.usage.input_tokens;
  }

  const deltaResult = extractDeltaContent(data, state.targetResponseId, state.currentThoughtIndex, state.reasoningBuffer);
  const { vStr, foundStr, isThinkingChunk } = deltaResult;
  state.currentThoughtIndex = deltaResult.currentThoughtIndex;

  if (!foundStr || vStr === '') return 'continue';
  if (vStr === 'FINISHED') return 'continue';

  if (isThinkingChunk) {
    if (state.reasoningBuffer.length < 20000) state.reasoningBuffer += vStr;
    // Write thinking content immediately for real-time reasoning_content streaming.
    // Clean XML artifacts to avoid leaking partial tool call syntax into reasoning (the
    // deferred flush was removed to prevent duplicate emission �?every chunk is written once).
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
  if (state.lastVStrRaw.length > 0) {
    const cumulativeDetection = detectCumulativeChunk(vStr, state.lastVStrRaw);
    if (cumulativeDetection.cumulative) {
      rawText = cumulativeDetection.delta;
      state.lastVStrRaw = vStr;
    } else if (!cumulativeDetection.delta) {
      rawText = '';
    } else {
      state.lastVStrRaw += vStr;
      if (state.lastVStrRaw.length > 100000) state.lastVStrRaw = state.lastVStrRaw.slice(-100000);
    }
  } else {
    state.lastVStrRaw = vStr;
  }

  // ── One-chunk buffer: delay chunks with '<' but no '>' ──────────
  // When an XML tag splits across SSE chunk boundaries (e.g. `<func` + `tion=read>`),
  // the first chunk has '<' without '>'. Delaying by 1 chunk lets us combine them
  // so cleanThinkTags sees the complete tag `<function=read>` and strips it via
  // prefix matching, instead of leaking partial fragments like `ction=read>`.
  //
  // If the combined text has '>', the tag completed �?toolCallDepth handles suppression.
  // If it still has no '>', cleanThinkTags still catches partial tags via TOOL_TAG_RE
  // prefix matching (the `` clause handles non-tool-call `<` content like "x < 3").
  // MAX_BUFFER_CHARS prevents indefinite buffering of `<` in non-XML text.

  if (state.pendingChunk) {
    rawText = state.pendingChunk + rawText;
    state.pendingChunk = '';
  }

  if (rawText.includes('<') && !rawText.includes('>') && rawText.length < MAX_BUFFER_CHARS) {
    // Pre-check: only buffer if the `<` looks like a tool/think tag start.
    // Check both full keywords AND prefixes of known keywords — a chunk like
    // `<func` should be buffered because it's the start of `<function=read>`.
    // Non-tag `<` (e.g. "x < 3", "grep '<pattern>'") should NOT trigger buffering.
    const allTagNames = [...TOOL_CALL_KEYWORDS, ...THINK_TAG_NAMES];
    const looksLikeTag = allTagNames.some(
      (kw) => rawText.includes(`<${kw}`) || rawText.includes(`</${kw}`),
    );
    // Also check prefixes: after `<`, is the text a prefix of any known keyword?
    // `<fu` → matches `function`, `<th` → matches `think`/`thought`
    const looksLikePrefix = !looksLikeTag && (() => {
      const ltIdx = rawText.lastIndexOf('<');
      if (ltIdx === -1) return false;
      const afterLt = rawText.slice(ltIdx + 1).toLowerCase();
      // At least 2 chars after `<` to be a meaningful prefix
      if (afterLt.length < 2) return true; // too short to tell — buffer just in case
      return allTagNames.some((kw) => {
        // Compare only a short prefix — `<functAAAA...` should match `function`
        // because the first 3+ chars match, even if trailing chars diverge.
        const minLen = Math.min(3, afterLt.length, kw.length);
        return kw.slice(0, minLen) === afterLt.slice(0, minLen);
      });
    })();
    if (looksLikeTag || looksLikePrefix) {
      state.pendingChunk = rawText;
      return 'continue';
    }
    // Fall through: `<` without `>` that doesn't look like a known tag —
    // treat as regular content (e.g. "x < 3", "grep '<pattern>'", etc.)
  }

  // At this point the text won't be delayed. Accumulate and process.
  state.lastRawContent += rawText;

  state.lastFullContent += rawText;

  // ── Loop detection: break on repetitive output ────────────
  if (rawText.length >= LOOP_MIN_CHARS && state.toolCallDepth === 0 && state.recentChunks) {
    state.recentChunks.push(rawText);
    if (state.recentChunks.length > LOOP_WINDOW * 2) {
      state.recentChunks = state.recentChunks.slice(-LOOP_WINDOW);
    }
    if (detectLoop(state.recentChunks)) {
      state.loopStreak++;
      if (state.loopStreak >= 2) {
        logStore.log('warn', 'chat', `[Chat] Loop detected — breaking stream (streak=${state.loopStreak})`);
        logStore.addError(logId, 'Model output loop detected — stream terminated');
        logStore.updateEntry(logId, (entry) => {
          entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
          entry.finalResponse.finishReason = 'loop_detected';
        });
        return 'break_stream';
      }
    } else {
      state.loopStreak = 0;
    }
  }
  // Performance: skip all downstream work when there's no new raw content.
  // This avoids the expensive parseXmlToolCalls (100KB buffer) and
  // filterContentPipeline on thinking-only or empty chunks.
  if (!rawText) return 'continue';

  // Track tool call depth to suppress content leaks from chunk-boundary fragments
  // When inside a tool call block (depth > 0), don't accumulate into
  // lastFilteredFullContent or emit content deltas to the client. The flush
  // path handles the clean version of the tool call text.
  const FKW = TOOL_CALL_KEYWORDS[0];
  const tagOpen = rawText.includes(`<${FKW}=`);
  const tagClose = rawText.includes(`</${FKW}>`);
  if (tagOpen) {
    state.toolCallDepth = Math.min(state.toolCallDepth + 1, MAX_TOOL_CALL_DEPTH);
    state.chunksSinceLastTagOpen = 0;
  } else if (state.toolCallDepth > 0) {
    state.chunksSinceLastTagOpen = (state.chunksSinceLastTagOpen || 0) + 1;
    // Safety valve: if no new open tag for too many consecutive chunks
    // while still inside a tool call block, the closing tag is never coming
    // (truncated stream, malformed output). Force-reset to prevent
    // permanent content suppression.
    if (state.chunksSinceLastTagOpen >= CHUNK_STUCK_THRESHOLD) {
      logStore.log('warn', 'chat', `[Chat] Tool call depth stuck at ${state.toolCallDepth} for ${CHUNK_STUCK_THRESHOLD} chunks — force-resetting to 0`);
      state.toolCallDepth = 0;
      state.chunksSinceLastTagOpen = 0;
    }
  }
  if (tagClose) {
    state.toolCallDepth = Math.max(0, state.toolCallDepth - 1);
    state.chunksSinceLastTagOpen = 0;
  }

  // Parse tool calls from the accumulated content
  const newToolCallContent = state.lastFullContent;
  const { toolCalls: xmlToolCalls } = parseXmlToolCalls(newToolCallContent);
  if (xmlToolCalls.length > 0) {
    const newToolCalls = xmlToolCalls.filter((tc) => {
      const key = `${tc.name}:${canonicalJson(tc.parameters)}`;
      if (state.loggedToolCalls.has(key)) return false;
      state.loggedToolCalls.add(key);
      return true;
    });

    if (newToolCalls.length > 0) {
      logStore.updateEntry(logId, (entry) => {
        for (const tc of newToolCalls) {
          entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.parameters) });
        }
      });
    }

    for (const [i, tc] of newToolCalls.entries()) {
      const parsed = xmlToolCallToParsed(tc, ctx.emittedToolCallCount + i);
      parsed.arguments = alignArgsToSchema(parsed.name, parsed.arguments, ctx.tools);
      await writeToolCallEvent(streamWriter, completionId, model, parsed, ctx.emittedToolCallCount + i);
    }
    ctx.emittedToolCallCount += newToolCalls.length;
  }

  // Truncate lastFullContent to prevent unbounded growth (M-10)
  // Use a generous limit (100000 chars �?25000 tokens) so the content delta
  // pipeline always has stable, growing input for getSnapshotDelta to diff.
  // When truncation IS triggered, also reset the snapshot trackers so
  // filterContentPipeline rebuilds from scratch for the next chunk.
  if (state.lastFullContent.length > 100000) {
    const trimmedAmount = state.lastFullContent.length - 80000;
    state.lastFullContent = state.lastFullContent.slice(-80000);
    // Adjust parse position relative to the trim (don't reset to 0 �?that
    // would re-parse the entire 80KB buffer, causing duplicate tool calls
    // and a burst of replayed content to the client).
    state.lastParsePosition = Math.max(0, state.lastParsePosition - trimmedAmount);
    state.lastFilteredSnapshot = '';
    state.lastThinkingSnapshot = '';
    state.lastFilteredFullContent = '';
    state.lastDeltaThinkingFull = '';
  }

  state.lastParsePosition = state.lastFullContent.length;

  if (state.loggedToolCalls.size > 500) state.loggedToolCalls.clear();

  // Incremental filtering: process only the new delta through the filter
  // pipeline instead of re-scanning the full accumulated buffer (up to 100KB)
  // on every chunk. Accumulate filtered output for snapshot diffing.
  //
  // Skip entirely when inside a tool call block (depth > 0): the filter
  // pipeline result would be discarded anyway (line 347 checks toolCallDepth),
  // but running it wastes regex cycles on content like "=filePath>" fragments.
  let deltaCleaned: string | null = null;
  let deltaThinking = '';
  if (state.toolCallDepth === 0) {
    // Force-release: when rawText has `<` but no `>`, escape `<` for the filter
    // pipeline only (rawText accumulation in lastFullContent keeps the original).
    // This prevents cleanThinkTags from stripping force-released content as partial tags.
    const filterInput = (!rawText.includes('>') && rawText.includes('<'))
      ? rawText.replace(/</g, '&lt;')
      : rawText;
    const filterDelta = filterContentPipeline(filterInput, enableContentFiltering, true);
    deltaCleaned = filterDelta.cleanText;
    deltaThinking = filterDelta.thinking;
  }

  // Only accumulate filtered content when outside a tool call block.
  // Inside a tool call (depth > 0), fragments like "-edit" or "=filePath>" would
  // leak through cleanThinkTags and corrupt the client's content stream.
  if (deltaCleaned && state.toolCallDepth === 0) state.lastFilteredFullContent = (state.lastFilteredFullContent || '') + deltaCleaned;
  if (deltaThinking) state.lastDeltaThinkingFull = (state.lastDeltaThinkingFull || '') + deltaThinking;

  const cleanedText = state.lastFilteredFullContent || null;
  const filteredThinking = state.lastDeltaThinkingFull || '';

  if (filteredThinking) {
    const thinkingDelta = getSnapshotDelta(filteredThinking, state.lastThinkingSnapshot);
    state.lastThinkingSnapshot = filteredThinking;
    if (thinkingDelta) {
      await writeReasoningEvent(streamWriter, completionId, model, thinkingDelta);
    }
  }

  if (cleanedText && state.toolCallDepth === 0) {
    // Text-only content (no tool calls): write content delta to SSE + logStore
    const contentDelta = getSnapshotDelta(cleanedText, state.lastFilteredSnapshot);
    state.lastFilteredSnapshot = cleanedText;
    if (contentDelta) {
      await writeContentDelta(
        streamWriter,
        completionId,
        model,
        contentDelta,
        ampState,
        logId,
        resolvedEmail,
        state.lastRawContent,
        state.lastVStrRaw,
        logStore,
      );
    }
  }

  if (streamFinished) return 'break_stream';
  return 'continue';
}


