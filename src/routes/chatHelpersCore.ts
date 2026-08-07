import { logStore } from '../services/logStore.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { LEAKED_TAG_KEYWORDS, TOOL_CALL_KEYWORDS, TOOL_RESULT_KEYWORDS } from '../utils/tagNames.ts';
import { QWEN_THINK_TAG_PATTERN as THINK_TAG_PATTERN } from '../utils/thinkTagStripper.ts';

// ── String / diff utilities ───────────────────────────────────────

export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[i] === b[i]) i++;
  return i;
}

export function getNewContent(text: string, lastEmittedText: string): string {
  if (!text) return '';
  const commonLen = commonPrefixLen(text, lastEmittedText);
  if (commonLen < text.length) return text.substring(commonLen);
  return '';
}

export function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  const len = Math.min(a.length, b.length);
  while (i < len && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

export type AnswerChunkMode = 'unknown' | 'incremental' | 'cumulative';

/**
 * Normalize Qwen answer chunks without dropping repeated incremental tokens.
 * Cumulative mode is selected only after a substantial previous chunk is
 * repeated as the exact prefix of a larger snapshot.
 */
export function normalizeAnswerChunk(
  newText: string,
  previousChunk: string,
  mode: AnswerChunkMode,
): { delta: string; previousChunk: string; mode: AnswerChunkMode } {
  if (!previousChunk) return { delta: newText, previousChunk: newText, mode };
  if (mode === 'cumulative') {
    if (newText === previousChunk) return { delta: '', previousChunk: newText, mode };
    if (newText.startsWith(previousChunk)) {
      return { delta: newText.slice(previousChunk.length), previousChunk: newText, mode };
    }
    return { delta: newText, previousChunk: newText, mode: 'incremental' };
  }
  if (previousChunk.length >= 8 && newText.length > previousChunk.length && newText.startsWith(previousChunk)) {
    return { delta: newText.slice(previousChunk.length), previousChunk: newText, mode: 'cumulative' };
  }
  // A substantial chunk repeated verbatim is a cumulative re-send, not repeated
  // tokens: Qwen re-emits the full answer as a same-length snapshot after the
  // incremental one. Appending it again duplicates the whole reply. Short chunks
  // stay incremental so genuinely repeated characters ("<<<") are preserved.
  if (newText === previousChunk && previousChunk.length >= 8) {
    return { delta: '', previousChunk: newText, mode: 'cumulative' };
  }
  return { delta: newText, previousChunk: newText, mode: mode === 'unknown' ? 'incremental' : mode };
}

export function detectCumulativeChunk(newText: string, lastText: string): { cumulative: boolean; delta: string } {
  if (!lastText || !newText) return { cumulative: false, delta: newText };
  if (newText === lastText) return { cumulative: false, delta: '' };

  // Fast path: exact prefix match
  if (newText.startsWith(lastText) && newText.length > lastText.length) {
    return { cumulative: true, delta: newText.substring(lastText.length) };
  }

  // Fingerprint-based recovery: Qwen sometimes resends cumulative content
  // with minor edits (extra words, rephrasing). Use suffix fingerprints to
  // find where old content resumes in the new text.
  if (newText.length > lastText.length && lastText.length >= 32) {
    // Try multiple fingerprint sizes for robustness
    for (const fpSize of [64, 48, 32, 24]) {
      if (lastText.length < fpSize) continue;
      const fingerprint = lastText.slice(-fpSize);
      const idx = newText.indexOf(fingerprint);
      if (idx === -1) continue;

      const expectedEnd = idx + lastText.length;
      if (expectedEnd > newText.length) continue;

      // Check if the found position is plausible: the overlap region at
      // expectedEnd should match the tail of lastText by at least 75%.
      const overlap = newText.substring(expectedEnd - Math.min(20, lastText.length), expectedEnd);
      const lastTail = lastText.slice(-overlap.length);
      const overlapMatch = commonSuffixLen(overlap, lastTail);
      if (overlapMatch < overlap.length * 0.75 && overlapMatch < 3) continue;

      const delta = newText.substring(expectedEnd);
      if (delta) {
        return { cumulative: true, delta };
      }
    }
  }

  return { cumulative: false, delta: newText };
}

export function getSnapshotDelta(newSnapshot: string, lastSnapshot: string): string {
  if (!newSnapshot) return '';
  if (!lastSnapshot) return newSnapshot;
  if (newSnapshot === lastSnapshot) return '';

  // Fast path: monotonic growth (the common case)
  if (newSnapshot.length > lastSnapshot.length && newSnapshot.startsWith(lastSnapshot)) return newSnapshot.substring(lastSnapshot.length);

  // When cleaning removes characters (e.g. partial <tool_call completing to
  // <tool_call> which then gets stripped by cleanThinkTags), newSnapshot can
  // be SHORTER than lastSnapshot. Use common prefix to find what's genuinely new.
  // Also handles the case where previous content was re-cleaned more aggressively.
  const prefixLen = commonPrefixLen(newSnapshot, lastSnapshot);
  if (prefixLen > 0 && prefixLen < newSnapshot.length) {
    return newSnapshot.substring(prefixLen);
  }
  if (prefixLen === newSnapshot.length && prefixLen > 0) {
    // newSnapshot is entirely a prefix of lastSnapshot — nothing genuinely new
    return '';
  }

  // Fallback: fingerprint-based cumulative chunk detection for overlapping content
  const detection = detectCumulativeChunk(newSnapshot, lastSnapshot);
  if (detection.cumulative) return detection.delta;
  return '';
}

/** Matches tool result tag fragments (requires closing > to avoid false stripping of /toolbox /toolkit etc). */
const TOOL_RESULT_TAG_PATTERN = new RegExp(`<\\/${TOOL_RESULT_KEYWORDS.join('|')}>`, 'gi');

/**
 * Data-driven regex builder for tool call XML tag & tail stripping.
 * Qwen's tool call format uses `<keyword=value>` and `</keyword>` patterns
 * where keyword is known (function, parameter). The SSE tokenizer can split
 * these at arbitrary byte boundaries (e.g., `<func` + `tion=name>`).
 *
 * Instead of hardcoding every possible split, we generate regexes from the
 * known keywords, computing:
 *  - Tag prefixes: all substrings ≥ MIN chars (handles chunk-boundary splits)
 *  - Continuation tails: what survives after the prefix was stripped
 *
 * Add new keywords to the array when Qwen's tool call format changes.
 */
const MIN_TOOL_PREFIX_LEN = 3;
const [TOOL_TAG_RE] = (() => {
  const keywords = TOOL_CALL_KEYWORDS;
  const tagPrefixes: string[] = [];

  for (const kw of keywords) {
    for (let i = MIN_TOOL_PREFIX_LEN; i <= kw.length; i++) {
      const p = kw.slice(0, i);
      tagPrefixes.push(p); // fun, funct, ..., /fun, /funct, ...
      tagPrefixes.push('/' + p);
    }
  }

  tagPrefixes.sort((a, b) => b.length - a.length);
  const tagRe = new RegExp(`<(?:${tagPrefixes.join('|')})[^>]*(?:>|$)`, 'gi');
  return [tagRe];
})();

export function cleanThinkTags(t: string): string {
  // Fast path: skip all regex work when there's no tag-like content or tail fragment
  // `>` is included because `word>` at line start (from `</keyword>` split) needs stripping
  if (!t.includes('<') && !t.includes('=') && !t.includes('>')) return t;
  let s = t.replace(THINK_TAG_PATTERN, '');
  s = s.replace(TOOL_RESULT_TAG_PATTERN, '');
  // Strip the gateway's own history wrapper tags that Qwen sometimes echoes back
  // as literal text (e.g. </assistant>, <assist>, </user>, <user>, <tool-result>).
  // These only appear in the prompt as gateway formatting; echoing them corrupts
  // the client's content stream.
  s = s.replace(/<\/?assistant\b[^>]*>/gi, '');
  s = s.replace(/<\/?assist\b[^>]*>/gi, '');
  s = s.replace(/<\/?user\b[^>]*>/gi, '');
  s = s.replace(/<tool-result\b[^>]*>[\s\S]*?<\/tool-result>/gi, '');
  s = s.replace(/<tool-result\b[^>]*>/gi, '');
  // Qwen echoes the gateway's plural <tool-results> wrapper (chat.ts:199) that
  // wraps tool output in context.txt. Both open and close tags leak back as
  // literal content — strip them so a "。\n\n</tool-results>" tail can't reach
  // the client.
  s = s.replace(/<\/?tool-results\b[^>]*>/gi, '');
  // Strip leaked tool_call / tool_use tags. Qwen's xml_prompt mode ends a call
  // with </function> but often appends a stray </tool_call> (a legacy-format
  // echo) right after — cleanThinkTags strips function/parameter/tool_result
  // but this one slipped through and leaked as literal content, adding a stray
  // newline before the answer text in tool-call turns.
  s = s.replace(new RegExp(`<\\/?(?:${LEAKED_TAG_KEYWORDS.join('|')})\\b[^>]*>`, 'gi'), '');
  // Strip tool call XML tags (complete + partial at chunk boundaries)
  s = s.replace(TOOL_TAG_RE, '');
  // Generic chunk-boundary artifact cleanup: works for ANY XML-like output from any AI,
  // not just known tool call keywords. Covers all fragment types that LLM tokenizers can
  // produce at arbitrary split points:
  //
  //   A. `=name>` at line start: `<keyword=name>` splits as `<keyword` + `=name>`.
  //   B. `tail=name>` at line start: `<keyword=name>` splits as `<key` + `word=name>`
  //      (e.g. `ction=filePath>` when the first 3 chars `fun` are in the previous chunk).
  //   C. `</` at end of string: `</keyword>` splits as `...</` + `keyword>`.
  //   D. `<` at end of string: `<keyword>` splits as `...<` + `keyword>`.
  //   E. `word>` at line start (from `</keyword>` split across chunks: `</` + `keyword>`).
  s = s.replace(/^=[^\s>]+>/gm, ''); // =name> continuation
  s = s.replace(/^[a-z]+=[^\s>]+>/gm, ''); // tail=name> continuation (generic, no keyword knowledge needed)
  s = s.replace(/^[a-z]{3,}>/gm, ''); // word> at line start (e.g. `function>` after `</` was stripped)
  s = s.replace(/^[ \t]*>[ \t]*$/gm, ''); // 孤立 > 行（工具闭合标签被切成 > 单独 chunk，如 `</tool_call>` → `</tool_call` + `>`）
  // 剥孤立闭合残片。Qwen 工具调用闭合后常回显一串切碎的闭合标签，SSE 把它们
  // 切成 `/Data\n</` + `tool_call>` 之类的残片。`</` 单独（后跟换行/空白/结尾）或
  // `</assist`、`</tool` 这类半截闭合（后跟小写字母直到换行/结尾）都必须剥掉，
  // 否则残片会当正文 emit（用户看到"正文+空行+孤立符号"）。
  // 注意只匹配后跟空白/换行/小写字母的形态，避免误伤 `x </ y` 这类本意内容。
  s = s.replace(/<\/(?=\s|$)/g, ''); // </ 后跟空白或结尾
  s = s.replace(/^<\/[a-z]+\s*$/gm, ''); // 行首 </assist / </tool 等半截闭合（独占一行）
  s = s.replace(/<\/[a-z]+\n/g, ''); // 闭合残片后跟换行（如 `</tool\n`、`</assist\n`）
  s = s.replace(/<\/[a-z]+$/g, ''); // 字符串末尾的 </tool / </assist 残片
  s = s.replace(/<\/(?=$)/g, ''); // </ at end of string
  s = s.replace(/<$/g, ''); // < at end of string
  return s;
}

export { compressToolResult, truncateToolResult } from './compressToolResult.ts';

// ── Tool and streaming utilities ──────────────────────────────────

export class ToolSpamGuard {
  private window: number;
  private threshold: number;
  private history: Array<{ key: string }>;

  constructor(window = 8, threshold = 2) {
    this.window = window;
    this.threshold = threshold;
    this.history = [];
  }

  private canonicalize(args: any): any {
    if (typeof args !== 'object' || args === null) return args;
    if (Array.isArray(args)) return args.map((a) => this.canonicalize(a));
    return Object.keys(args)
      .sort()
      .reduce((acc: any, key) => {
        acc[key] = this.canonicalize(args[key]);
        return acc;
      }, {});
  }

  check(tool: string, args: any): { ok: true } | { ok: false; correctionPrompt: string } {
    const key = `${tool}:${JSON.stringify(this.canonicalize(args))}`;
    const recent = this.history.slice(-this.window);
    const count = recent.filter((h) => h.key === key).length + 1;
    this.history.push({ key });
    if (this.history.length > this.window * 2) this.history = this.history.slice(-this.window);
    if (count > this.threshold) {
      return {
        ok: false,
        correctionPrompt:
          `[TOOL SPAM] Called "${tool}" with identical arguments ${count} times in the last ${this.window} calls. ` +
          `Stop repeating this call. Analyze the results you already have and respond to the user. ` +
          `Do NOT call "${tool}" again with the same arguments.`,
      };
    }
    return { ok: true };
  }
}

export const pendingCorrections = new Map<string, string[]>();

// Prevent unbounded growth: trim oldest entries every 5 minutes
const MAX_PENDING_CORRECTIONS = 500;
setInterval(
  () => {
    if (pendingCorrections.size > MAX_PENDING_CORRECTIONS) {
      const toDelete = pendingCorrections.size - MAX_PENDING_CORRECTIONS;
      let i = 0;
      for (const key of pendingCorrections.keys()) {
        if (i >= toDelete) break;
        pendingCorrections.delete(key);
        i++;
      }
    }
  },
  5 * 60 * 1000,
).unref();

export function parseQwenErrorPayload(
  raw: string,
): { message: string; status: import('hono/utils/http-status').ContentfulStatusCode; code?: string; upstreamCode?: string } | null {
  let text = raw.trim();
  if (!text) return null;
  // Strip SSE data: prefix if present — used when checking full buffer content
  if (text.startsWith('data: ')) text = text.slice(6).trim();
  // Skip SSE control lines and [DONE]
  if (text === '[DONE]' || text.startsWith(':')) return null;
  try {
    const payload = JSON.parse(text);
    // Alibaba WAF CAPTCHA punishment — returned as HTTP 200 with an SSE line
    // shaped {ret:["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::..."], data:{url:...}}.
    // Previously this fell through to the empty-response guard (502 "empty response"),
    // hiding the real cause. Surface it as an explicit upstream error instead.
    if (Array.isArray(payload?.ret) && payload.ret[0] === 'FAIL_SYS_USER_VALIDATE') {
      const detail = payload.ret[1] || 'RGV587 captcha required';
      return {
        message: `Qwen CAPTCHA required (WAF anti-bot): ${detail}`,
        status: 502,
        code: 'waf_captcha',
        upstreamCode: 'FAIL_SYS_USER_VALIDATE',
      };
    }
    if (payload && payload.success === false) {
      const code = payload.data?.code || payload.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || 'Qwen returned an error';
      const wait = payload.data?.num !== undefined ? ` Wait about ${payload.data.num} hour(s) before trying again.` : '';
      const status = code === 'RateLimited' ? 429 : code === 'Not_Found' ? 404 : 502;
      return { message: `Qwen upstream error: ${code}: ${details}.${wait}`, status, code, upstreamCode: code };
    }
    if (payload && payload.error) {
      const msg = typeof payload.error === 'string' ? payload.error : payload.error.message || JSON.stringify(payload.error);
      return { message: `Qwen upstream error: ${msg}`, status: 502, code: 'upstream_error', upstreamCode: payload.error?.code || payload.code };
    }
  } catch {
    return null;
  }
  return null;
}

export interface DeltaContentResult {
  vStr: string;
  foundStr: boolean;
  isThinkingChunk: boolean;
  currentThoughtIndex: number;
}

export function extractDeltaContent(
  chunk: any,
  knownResponseIds: Set<string>,
  currentThoughtIndex: number,
  reasoningBuffer: string,
): DeltaContentResult {
  let vStr = '';
  let foundStr = false;
  let isThinkingChunk = false;
  let newThoughtIndex = currentThoughtIndex;

  const createdId = chunk['response.created']?.response_id;
  const idOk =
    knownResponseIds.size === 0 ||
    !chunk.response_id ||
    knownResponseIds.has(chunk.response_id) ||
    (createdId != null && knownResponseIds.has(createdId));

  if (
    chunk.choices &&
    chunk.choices[0] &&
    chunk.choices[0].delta &&
    idOk
  ) {
    const delta = chunk.choices[0].delta;
    if (delta.phase === 'thinking_summary') {
      isThinkingChunk = true;
      if (delta.extra && delta.extra.summary_thought && delta.extra.summary_thought.content) {
        const thoughts = delta.extra.summary_thought.content;
        const rawNew = thoughts.slice(currentThoughtIndex).join('\n');
        if (rawNew) {
          const commonLen = commonPrefixLen(rawNew, reasoningBuffer);
          vStr = rawNew.substring(commonLen);
          if (vStr) {
            newThoughtIndex = thoughts.length;
            foundStr = true;
          }
        }
      }
    } else if (delta.phase === 'think') {
      isThinkingChunk = true;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.phase === 'answer') {
      isThinkingChunk = false;
      if (delta.content !== undefined) {
        vStr = delta.content || '';
        if (vStr) foundStr = true;
      }
    } else if (delta.reasoning_content !== undefined && delta.reasoning_content) {
      // OpenAI-compatible format (no phase field): reasoning_content for thinking
      isThinkingChunk = true;
      vStr = delta.reasoning_content;
      if (vStr) foundStr = true;
    } else if (delta.content !== undefined && delta.content && !delta.phase) {
      // OpenAI-compatible format (no phase field): content for answer
      isThinkingChunk = false;
      vStr = delta.content;
      if (vStr) foundStr = true;
    }
  }
  return { vStr, foundStr, isThinkingChunk, currentThoughtIndex: newThoughtIndex };
}

export interface ToolCallProcessingOptions {
  label?: string;
  logParsed?: boolean;
  logId: string;
  toolSpamGuard: ToolSpamGuard;
  correctionPrompts: string[];
  maxToolCalls: number;
}

export function processToolCallsThroughGuard(toolCalls: any[], toolCallsOut: any[], options: ToolCallProcessingOptions): void {
  const { label, logParsed = false, logId, toolSpamGuard, correctionPrompts, maxToolCalls } = options;
  const effectiveMax = maxToolCalls ?? 8;

  if (toolCalls.length > effectiveMax) {
    logStore.log(
      'debug',
      'chat',
      `  [🛑 TOOL LIMIT${label ? ' ' + label : ''}] Truncating ${toolCalls.length} tool calls to first ${effectiveMax}`,
    );
    toolCalls = toolCalls.slice(0, effectiveMax);
  }

  for (const tc of toolCalls) {
    const guard = validateSingleToolCall(tc);
    if (!guard.ok) {
      correctionPrompts.push(guard.correctionPrompt);
      continue;
    }
    const spamCheck = toolSpamGuard.check(tc.name, tc.arguments);
    if (!spamCheck.ok) {
      logStore.log('debug', 'chat', `  [🛑 TOOL SPAM${label ? ' ' + label : ''}] ${tc.name}: repeated call blocked`);
      correctionPrompts.push(spamCheck.correctionPrompt);
      continue;
    }
    if (toolCallsOut.length >= maxToolCalls) {
      logStore.log(
        'debug',
        'chat',
        `  [🛑 TOOL LIMIT${label ? ' ' + label : ''}] Hit ${maxToolCalls} tool calls per turn, dropping excess`,
      );
      correctionPrompts.push(
        `[TOOL CALL LIMIT] Reached maximum of ${maxToolCalls} tool calls per turn. Analyze existing results and respond to the user.`,
      );
      break;
    }
    toolCallsOut.push({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    });
    if (logParsed) {
      logStore.updateEntry(logId, (entry: any) => {
        entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
      });
    }
  }
}

export interface AmplificationGuardState {
  rawInputBytes: number;
  emittedOutputBytes: number;
  triggered: boolean;
}

export function checkAmplificationGuard(
  state: AmplificationGuardState,
  newOutputLen: number,
  logId: string,
  resolvedEmail: string,
  model: string,
  lastRawContent: string,
  lastVStrRaw: string,
): boolean {
  if (!state.triggered) {
    const projectedRatio = (state.emittedOutputBytes + newOutputLen) / Math.max(1, state.rawInputBytes);
    if (projectedRatio > 10 && state.emittedOutputBytes > 5000) {
      state.triggered = true;
      const ratio = Math.round(projectedRatio * 100) / 100;
      console.error(
        `[Chat][AMPLIFICATION GUARD] Triggered! ratio=${ratio}x rawIn=${state.rawInputBytes}B emittedOut=${state.emittedOutputBytes}B account=${resolvedEmail} model=${model}`,
      );
      logStore.recordAmplificationEvent(logId, ratio, lastRawContent || lastVStrRaw || '');
    }
  }
  return state.triggered;
}
