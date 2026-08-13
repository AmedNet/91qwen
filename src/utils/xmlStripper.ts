import {
  ALL_TOOL_KEYWORDS,
  FUNCTION_CALLS_TAGS,
  LLM_META_CLOSE_TAGS,
  LLM_META_TAGS,
  LLM_STRUCTURE_TAGS,
  PRESERVED_HTML_TAGS,
  TOOL_CALL_KEYWORDS,
  TOOL_RESULT_KEYWORDS,
} from './tagNames.ts';

/**
 * Tool echo patterns — strip lines where the model echoes tool results
 * as JSON: [{"type":"function","tool":"name","result":{...}}]
 */
const TOOL_ECHO_PATTERNS: RegExp[] = [
  // Single-line JSON tool result echo: [{"type":"function","tool":"name","result":{...}}]
  /^\[\s*\{.*"type"\s*:\s*"function".*"tool"\s*:\s*"/i,
];

export function stripToolCallArtifacts(text: string): string {
  if (!text) return '';
  const resultNames = TOOL_RESULT_KEYWORDS.join('|');
  // Malformed parameter-only blocks (missing `<function=...>`) must still be
  // stripped together with their parameter values.
  const toolMarkupRe = new RegExp(
    TOOL_CALL_KEYWORDS.map((kw) => `<${kw}=[^\\s>][^>]*>[\\s\\S]*?(?:<\\/${kw}>|$)`).join('|'),
    'g',
  );
  text = text.replace(toolMarkupRe, '');
  text = text.replace(/<\/(?:function|parameter)>/g, '');
  const newToolNames = [...FUNCTION_CALLS_TAGS, 'parameter'].join('|');
  text = text.replace(new RegExp(`<(?:${newToolNames})\\b[^>]*>[\\s\\S]*?<\\/(?:${newToolNames})>`, 'g'), '');
  text = text.replace(new RegExp(`<(?:${newToolNames})\\b[^>]*>[\\s\\S]*$`, 'g'), '');
  text = text.replace(new RegExp(`<\\/(?:${newToolNames})>`, 'g'), '');
  // Tagless tool result echoes: `tool_result tool_name="..." success="true">`
  // or an orphan `tool_name="..." success="true">` opening, followed by stdout content.
  // NOTE: `tool_name` prefix is REQUIRED to avoid false positives on arbitrary
  // text containing `="..." success="...">` (e.g. user discussing HTML attributes).
  const resultEchoRe = new RegExp(
    `(?:^|\\n)\\s*(?:tool_(?:result|call|use)\\s+tool_name\\s*=\\s*(?:"[^"]*"|[^\\s>]+)[^>]*>|tool_name="[^"]*"\\s+success="[^"]*"[^>]*>)[\\s\\S]*?(?:<\\/(?:${resultNames})>|$)`,
    'g',
  );
  text = text.replace(resultEchoRe, '');
  text = text.replace(/<(?:command|stdout|stderr)[^>]*>[\s\S]*?<\/(?:command|stdout|stderr)>/g, '');
  text = text.replace(/<(?:command|stdout|stderr)[^>]*>[\s\S]*$/g, '');
  text = text.replace(/<\/(?:command|stdout|stderr)>/g, '');
  // Strip legacy Qwen tool-result blocks (complete pairs).
  const blockOpenRe = new RegExp(`<(?:${resultNames})[^>]*>[\\s\\S]*?<\\/(?:${resultNames})>`, 'g');
  text = text.replace(blockOpenRe, '');
  // Strip orphaned result-tag opens without a matching close.
  const orphanOpenRe = new RegExp(`<(?:${resultNames})(?:\\s[^>]*)?>`);
  const unmatchedOpenIdx = text.search(orphanOpenRe);
  if (unmatchedOpenIdx !== -1) {
    text = text.substring(0, unmatchedOpenIdx);
  }
  // Strip residual closing result tags without a matching open.
  const orphanCloseRe = new RegExp(`<\\/(?:${resultNames})\\s*>`, 'g');
  text = text.replace(orphanCloseRe, '');
  // Strip garbled close tags like </prefix_tool_result>.
  const garbledCloseRe = new RegExp(`<\\/(?:\\w+)?(?:${resultNames})\\s*>`, 'g');
  text = text.replace(garbledCloseRe, '');
  // Strip <environment_details> blocks (model-generated context artifacts)
  const envDetailsRe = /<environment_details>[\s\S]*?<\/environment_details>/g;
  text = text.replace(envDetailsRe, '');
  // Strip partial / incomplete tool tags at end of text (streaming boundaries).
  // These are conservatively matched — only unambiguous tool tag prefixes.
  // Combined into a single regex built from the shared keyword array.
  const streamBoundaryRe = new RegExp(`\\n?<(?:${ALL_TOOL_KEYWORDS.join('|')})(?:\\s[^>]*)?$`, 'g');
  text = text.replace(streamBoundaryRe, '');
  // Strip any remaining closing tool tags (with > requirement to avoid
  // matching </toolbox, </toolkit etc.)
  const toolCloseRe = new RegExp(`<\\/(?:${resultNames})>`, 'g');
  text = text.replace(toolCloseRe, '');
  // Strip JSON tool result echo blocks (handles both single-line and pretty-printed multi-line):
  //   [{"type":"function","tool":"name","result":{"success":true,"stdout":"...","stderr":"","command":"name"}}]
  text = text.replace(/\[\s*\{[\s\S]*?"type"\s*:\s*"function"[\s\S]*?"tool"\s*:\s*"[a-z_]+"[\s\S]*?\}\s*\]/g, '');
  // Strip LLM-metadata tag pairs (<plan>, <purpose>, <answer>, ...) and any
  // generic <tag>...</tag> whose name is not in PRESERVED_HTML_TAGS. Covers
  // the leak where Qwen's output_schema='phase' boundaries are misaligned
  // and the model emits its internal scaffolding into the answer stream.
  // Strip orphaned conversation-structure closers (</assist>, </invoke>)
  // that the model echoes back into the answer stream.
  const STRUCTURE_CLOSE_RE = new RegExp(
    `<\\/(?:${LLM_STRUCTURE_TAGS.join('|')})>`,
    'gi',
  );
  text = text.replace(STRUCTURE_CLOSE_RE, '');
  text = stripUnknownLlmMetaTags(text);
  // Strip orphaned LLM metadata closers such as `</plan>` or `</purpose>`.
  // These are harmless when part of a complete pair, but leak as plain text
  // when a meta-tag block is split across stream chunks.
  const META_CLOSE_RE = new RegExp(
    `</(?:${LLM_META_CLOSE_TAGS.join('|')})>`,
    'gi',
  );
  text = text.replace(META_CLOSE_RE, '');
  text = stripToolEcho(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

// Same implementation as the stripper in tools/xmlToolParser.ts but exposed
// here so contentFilter can sanitize isolated segments without pulling in
// the tool-call parser. Idempotent — safe to run multiple times.
const PRESERVED_SET = new Set<string>(PRESERVED_HTML_TAGS);
const META_TAG_NAMES = [...new Set(LLM_META_TAGS.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
const META_OPEN_CLOSE_RE = new RegExp(
  `<(${META_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  'gi',
);
const GENERIC_PAIR_RE = /<([a-z][a-z0-9-]{0,39})\b[^>]*>[\s\S]*?<\/\1>/gi;
// "Answer-wrapping" tags: drop the wrapper, keep the inner content (see
// ANSWER_WRAPPER_RE comment in tools/xmlToolParser.ts for rationale).
const ANSWER_WRAPPER_RE = /<\/?(answer|response)\b[^>]*>/gi;

function stripUnknownLlmMetaTags(text: string): string {
  let out = text.replace(ANSWER_WRAPPER_RE, '');
  out = out.replace(META_OPEN_CLOSE_RE, '');
  out = out.replace(GENERIC_PAIR_RE, (match, name: string) =>
    PRESERVED_SET.has(name.toLowerCase()) ? match : '',
  );
  return out;
}

export function stripToolEcho(text: string): string {
  if (!text) return '';
  let result = text;
  const originalLines = text.split('\n');
  const filteredLines: string[] = [];
  for (const line of originalLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      filteredLines.push(line);
      continue;
    }
    let isEcho = false;
    for (const pattern of TOOL_ECHO_PATTERNS) {
      if (pattern.test(trimmed)) {
        isEcho = true;
        break;
      }
    }
    if (!isEcho) {
      filteredLines.push(line);
    }
  }
  result = filteredLines.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}
