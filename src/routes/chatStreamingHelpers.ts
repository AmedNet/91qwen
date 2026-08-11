import { logStore } from '../services/logStore.ts';
import { logQwenSSE } from '../services/qwenLogger.ts';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls, xmlToolCallToParsed } from '../tools/xmlToolParser.ts';
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

import { buildErrorEvent, writeContentDelta, writeEvent, writeReasoningEvent, writeToolCallEvent } from './writeHelpers.ts';

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

// ── Tool call open/close tag counters ────────────────────────────────
// Pre-compiled to avoid recompilation on every chunk (called 50-200x per
// streaming request). Counters stay accurate across SSE chunk boundaries:
// a single `<function=NAME>...</function>` block may be split mid-tag
// across multiple chunks, so per-chunk `rawText.includes(...)` checks fail
// to track depth correctly. Counting open/close occurrences on the
// post-pendingChunk merged text, and accumulating into state, guarantees
// toolCallDepth matches the actual open-block count in lastFullContent.
const FKW = TOOL_CALL_KEYWORDS[0]; // 'function'
const TOOL_TAG_OPEN_RE = new RegExp(`<${FKW}=[^\\s>>]+`, 'g');
const TOOL_TAG_CLOSE_RE = new RegExp(`</${FKW}>`, 'g');

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
   * Cumulative counter for `<function=` occurrences seen so far across all
   * processed chunks. Maintained alongside `closeFnTagCount` so the resulting
   * toolCallDepth is accurate even when chunk boundaries split a tag
   * (e.g. `<function=shell` + `_command>\n...`). Reset to 0 at stream start.
   */
  openFnTagCount: number;
  /** Cumulative counter for `</function>` occurrences seen so far across all chunks. */
  closeFnTagCount: number;
  /**
   * One-chunk buffer for handling XML tag splits across SSE chunk boundaries.
   * When a chunk contains `<` without `>`, it might be a tag split (e.g. `<func` + `tion=read>`).
   * We buffer the incomplete chunk and wait for the next chunk. If combining them completes a
   * known tool call tag, toolCallDepth suppresses content emission. If not, the combined text
   * is regular content and is emitted normally. Max buffer size prevents indefinite buffering
   * of `<` in non-XML text (e.g. "x < 3").
   */
  pendingChunk: string;
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
}

export type ProcessStreamResult = 'continue' | 'break_stream';

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
    logStore.addError(logId, `Qwen upstream SSE error: ${errMsg}`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    await writeEvent(
      streamWriter,
      buildErrorEvent(completionId, model, {
        message: errMsg,
        type: 'server_error',
        code: 'upstream_sse_error',
        retryable: true,
        retryAfterMs: 2000,
      }),
    );
    return 'break_stream';
  }
  const deltaStatus = data.choices?.[0]?.delta?.status;
  if (deltaStatus === 'error') {
    logStore.addError(logId, `Qwen stream delta returned error status`);
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    await writeEvent(
      streamWriter,
      buildErrorEvent(completionId, model, {
        message: 'Upstream stream delta returned error status',
        type: 'server_error',
        code: 'upstream_delta_error',
        retryable: true,
        retryAfterMs: 2000,
      }),
    );
    return 'break_stream';
  }
  let streamFinished = false;
  if (deltaStatus === 'finished') {
    const deltaPhase = data.choices[0].delta.phase;
    if (deltaPhase !== 'thinking_summary' && deltaPhase !== 'think') {
      streamFinished = true;
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

  // ── One-chunk buffer: delay chunks that may be split mid-tag ─────
  // Two mirror cases both delay by one chunk so tag opens/closes that
  // straddle the SSE chunk boundary can be combined:
  //   1. Chunk has '<' but no '>'      → tag open might be incomplete
  //      (e.g. `<func` + `tion=read>`)
  //   2. Chunk ends with `</[A-Za-z]*` → tag close might be incomplete
  //      (e.g. `</` + `function>`)
  // Without case 2, a `</function>` close that splits into `</` and
  // `function>` would leak the open-tag content (mid-block fragments) to
  // the client before the close arrived — the close regex would never
  // see a complete `</function>` and toolCallDepth would never decrement.
  // MAX_BUFFER_CHARS prevents indefinite buffering of non-tag content
  // such as "x < 3" that happens to satisfy these patterns.

  if (state.pendingChunk) {
    rawText = state.pendingChunk + rawText;
    state.pendingChunk = '';
  }

  const hasOpenBracketNoClose = rawText.includes('<') && !rawText.includes('>');
  // Case 2: tail like `</` or `</function` (still missing the trailing `>`).
  const trailingCloseStart = /<\/[A-Za-z]*$/.test(rawText) && !rawText.endsWith('>');
  if ((hasOpenBracketNoClose || trailingCloseStart) && rawText.length < MAX_BUFFER_CHARS) {
    state.pendingChunk = rawText;
    return 'continue';
  }

  // At this point the text won't be delayed. Accumulate and process.
  state.lastRawContent += rawText;
  state.lastFullContent += rawText;

  // Performance: skip all downstream work when there's no new raw content.
  // This avoids the expensive parseXmlToolCalls (100KB buffer) and
  // filterContentPipeline on thinking-only or empty chunks.
  if (!rawText) return 'continue';

  // Track tool call depth to suppress content leaks from chunk-boundary fragments
  // When inside a tool call block (depth > 0), don't accumulate into
  // lastFilteredFullContent or emit content deltas to the client. The flush
  // path handles the clean version of the tool call text.
  //
  // Count occurrences in this merged rawText (post-pendingChunk) and
  // accumulate into state. Per-chunk `includes(...)` checks fail when a
  // tag is split across chunks (e.g. `<function=shell` ends one chunk,
  // `_command>...` begins the next), which previously caused the entire
  // `<function=...>...</function>` block to be emitted to the client as
  // plain text. Counting every occurrence on every chunk — including
  // split-tag cases where the open/close strings appear intact only after
  // pendingChunk merge — closes that gap.
  TOOL_TAG_OPEN_RE.lastIndex = 0;
  TOOL_TAG_CLOSE_RE.lastIndex = 0;
  let chunkOpens = 0;
  while (TOOL_TAG_OPEN_RE.exec(rawText) !== null) chunkOpens++;
  let chunkCloses = 0;
  while (TOOL_TAG_CLOSE_RE.exec(rawText) !== null) chunkCloses++;
  state.openFnTagCount += chunkOpens;
  state.closeFnTagCount += chunkCloses;
  state.toolCallDepth = Math.max(0, state.openFnTagCount - state.closeFnTagCount);

  // Parse tool calls from the accumulated content
  const newToolCallContent = state.lastFullContent;
  const { toolCalls: xmlToolCalls } = parseXmlToolCalls(newToolCallContent);
  if (xmlToolCalls.length > 0) {
    const newToolCalls = xmlToolCalls.filter((tc) => {
      const key = `${tc.name}:${JSON.stringify(tc.parameters)}`;
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
      await writeToolCallEvent(streamWriter, completionId, model, parsed, ctx.emittedToolCallCount + i);
    }
    ctx.emittedToolCallCount += newToolCalls.length;
  }

  // Truncate lastFullContent to prevent unbounded growth (M-10)
  // Use a generous limit (100000 chars ≈ 25000 tokens) so the content delta
  // pipeline always has stable, growing input for getSnapshotDelta to diff.
  // When truncation IS triggered, also reset the snapshot trackers so
  // filterContentPipeline rebuilds from scratch for the next chunk.
  if (state.lastFullContent.length > 100000) {
    const trimmedAmount = state.lastFullContent.length - 80000;
    state.lastFullContent = state.lastFullContent.slice(-80000);
    // Adjust parse position relative to the trim (don't reset to 0 — that
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
    const filterDelta = filterContentPipeline(rawText, enableContentFiltering, true);
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
