import crypto from 'node:crypto';
import {
  LLM_META_CLOSE_TAGS,
  LLM_META_TAGS,
  LLM_STRUCTURE_TAGS,
  PRESERVED_HTML_TAGS,
  FUNCTION_CALLS_TAGS,
  TOOL_CALL_KEYWORDS,
  TOOL_RESULT_KEYWORDS,
} from '../utils/tagNames.ts';

export interface ParsedXmlToolCall {
  name: string;
  parameters: Record<string, string>;
}

// ── Pre-compiled regexes for parse path ──
// Lifted to module-level to avoid recompilation on every parseXmlToolCalls() call
// (called 50-200 times per streaming request).
const FKW = TOOL_CALL_KEYWORDS[0]; // 'function' — the block-level keyword
const PKW = TOOL_CALL_KEYWORDS[1]; // 'parameter' — the parameter keyword
const FUNCTION_BLOCK_RE = new RegExp(`<${FKW}=[^\\s>]+[\\s\\S]*?>[\\s\\S]*?(?:<\\/${FKW}>|$)`, 'g');
const PARAM_RE = new RegExp(`<${PKW}=([^\\s>]+)>([\\s\\S]*?)<\\/${PKW}>`, 'g');
const FUNC_NAME_RE = new RegExp(`^<${FKW}=([^\\s>]+)>`);
const FUNCTION_CALLS_BLOCK_RE = /<function_calls\b[^>]*>([\s\S]*?)<\/function_calls>/g;
const INVOKE_OPEN_RE = /<invoke\b[^>]*?\bname="([^"]+)"[^>]*>/g;
const PARAM_OPEN_RE = /<parameter\b[^>]*?\bname="([^"]+)"[^>]*>([\s\S]*?)(?=<parameter\b|<\/parameter>|<invoke\b|<\/invoke>|<\/function_calls>|$)/g;

function functionNameFromTag(tag: string): string | null {
  // Match function name from <KEYWORD=NAME...> — NAME can be any non-whitespace, non-> chars
  const m = tag.match(FUNC_NAME_RE);
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  let cleanedText = text;

  // Newer Qwen format:
  // <function_calls>
  //   <invoke name="execute_command">
  //     <parameter name="command">...</parameter>
  //   </invoke>
  // </function_calls>
  FUNCTION_CALLS_BLOCK_RE.lastIndex = 0;
  let callsMatch: RegExpExecArray | null;
  while ((callsMatch = FUNCTION_CALLS_BLOCK_RE.exec(cleanedText)) !== null) {
    const block = callsMatch[1];
    const invokeMatches = Array.from(block.matchAll(INVOKE_OPEN_RE));
    for (let i = 0; i < invokeMatches.length; i++) {
      const invokeMatch = invokeMatches[i];
      const name = invokeMatch[1].trim();
      const invokeBodyStart = (invokeMatch.index || 0) + invokeMatch[0].length;
      const invokeBodyEnd = i + 1 < invokeMatches.length ? invokeMatches[i + 1].index! : block.length;
      const invokeBody = block.slice(invokeBodyStart, invokeBodyEnd);
      const parameters: Record<string, string> = {};
      PARAM_OPEN_RE.lastIndex = 0;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = PARAM_OPEN_RE.exec(invokeBody)) !== null) {
        parameters[paramMatch[1].trim()] = paramMatch[2].trim();
      }
      toolCalls.push({ name, parameters });
    }
    cleanedText = cleanedText.replace(callsMatch[0], '');
    FUNCTION_CALLS_BLOCK_RE.lastIndex = 0;
  }

  // Legacy format: <function=name><parameter=key>value</parameter></function>
  const unique = new Set<string>();
  const hasLegacyToolCallStart = TOOL_CALL_KEYWORDS.some((kw) => cleanedText.includes(`<${kw}=`));
  if (!hasLegacyToolCallStart) {
    return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n') };
  }

  // Semantics: <keyword=NAME...chars...> body </keyword>
  // Matches the opening <keyword=, captures until first >, then lazily until </keyword> or end.
  FUNCTION_BLOCK_RE.lastIndex = 0;
  const re = FUNCTION_BLOCK_RE;
  const sections: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleanedText)) !== null) {
    if (unique.has(match[0])) continue;
    unique.add(match[0]);

    const name = functionNameFromTag(match[0]);
    if (!name) continue;

    const closingTag = `</${FKW}>`;
    const closingIndex = match[0].lastIndexOf(closingTag);
    if (closingIndex === -1) continue; // malformed — no closing tag
    const body = match[0].slice(match[0].indexOf('>') + 1, closingIndex);

    const parameters: Record<string, string> = {};
    PARAM_RE.lastIndex = 0;
    const paramRe = PARAM_RE;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      parameters[pm[1].trim()] = pm[2].trim();
    }

    toolCalls.push({ name, parameters });
    sections.push(cleanedText.slice(lastIdx, match.index));
    lastIdx = re.lastIndex;
  }

  sections.push(cleanedText.slice(lastIdx));
  cleanedText = sections.join('');

  return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n') };
}

/**
 * Pre-compiled regexes for stripping remaining XML markup.
 * Built dynamically from the shared TOOL_CALL_KEYWORDS array so adding
 * new tool call tag keywords is a one-line change.
 */
const [TOOL_MARKUP_RE, ENV_DETAILS_RE, EXCESS_NEWLINES_RE] = (() => {
  const markupParts: string[] = [];
  for (const kw of TOOL_CALL_KEYWORDS) {
    markupParts.push(`<${kw}=[^\\s>][^>]*>[\\s\\S]*?(?:<\\/${kw}>|$)`);
    markupParts.push(`<${kw}=[^>]*(?:>|(?=\\n|$))`);
    markupParts.push(`<${kw}(?=[\\s<]|$)`);
    markupParts.push(`<\\/?${kw}>`);
  }
  const envDetailsRe = /<environment_details>[\s\S]*?<\/environment_details>/g;
  return [new RegExp(markupParts.join('|'), 'g'), envDetailsRe, /\n{3,}/g];
})();

const NEW_TOOL_NAMES = `${FUNCTION_CALLS_TAGS.join('|')}|parameter`;
const NEW_TOOL_BLOCK_RE = new RegExp(`<(?:${NEW_TOOL_NAMES})\\b[^>]*>[\\s\\S]*?<\\/(?:${NEW_TOOL_NAMES})>`, 'g');
const NEW_TOOL_ORPHAN_TO_END_RE = new RegExp(`<(?:${NEW_TOOL_NAMES})\\b[^>]*>[\\s\\S]*$`, 'g');
const NEW_TOOL_ORPHAN_CLOSE_RE = new RegExp(`<\\/(?:${NEW_TOOL_NAMES})>`, 'g');

const TOOL_RESULT_NAMES = TOOL_RESULT_KEYWORDS.join('|');
const TOOL_RESULT_BLOCK_RE = new RegExp(
  `<(?:${TOOL_RESULT_NAMES})[^>]*>[\\s\\S]*?<\\/(?:${TOOL_RESULT_NAMES})>`,
  'g',
);
const TOOL_RESULT_ORPHAN_RE = new RegExp(
  `<(?:${TOOL_RESULT_NAMES})\\b[^>]*>[\\s\\S]*$`,
  'g',
);
// Qwen sometimes emits tool results without the leading `<` on the opening
// tag, e.g. `tool_result tool_name="shell_command" success="true">`.
const TOOL_RESULT_TAGLESS_RE = new RegExp(
  `(?:^|\\n)\\s*tool_(?:result|call|use)\\s+tool_name\\s*=\\s*(?:"[^"]*"|[^\\s>]+)[^>]*>[\\s\\S]*?(?:<\\/(?:${TOOL_RESULT_NAMES})>|$)`,
  'g',
);
const TOOL_NAME_ORPHAN_RE = new RegExp(
  `(?:^|\\n)\\s*(?:(?:tool_name)?="[^"]*"|tool_name=[^\\s>]+)\\s+success="[^"]*"[^>]*>`,
  'g',
);
const COMMAND_STDOUT_BLOCK_RE = /<(?:command|stdout|stderr)[^>]*>[\s\S]*?<\/(?:command|stdout|stderr)>/g;
const ORPHAN_COMMAND_STDOUT_RE = /<(?:command|stdout|stderr)[^>]*>[\s\S]*$/g;

// Generic LLM-metadata tag stripping. The Qwen upstream occasionally leaks
// its own internal scaffolding (<plan>, <purpose>, <answer>, ...) into the
// answer stream when output_schema='phase' boundaries are misaligned. We
// strip any complete <tag>...</tag> pair whose name is:
//   1. In the LLM_META_TAGS whitelist (always stripped, even mid-content), OR
//   2. A short, lowercase, hyphen-allowed word that is NOT in PRESERVED_HTML_TAGS
//      (default-deny for anything that looks like a tag but isn't a known
//      semantic HTML element).
//
// Tag name matcher: lowercase letters, digits, hyphens. Must start with a
// letter. Maximum 40 chars to avoid pathological regex on garbage input.
// Attribute syntax (<tag attr="x">) is permitted — attributes are dropped
// along with the tag, since leaked LLM metadata never has useful attrs.
const PRESERVED_SET = new Set<string>(PRESERVED_HTML_TAGS);
const META_SET = new Set<string>(LLM_META_TAGS.map((t) => t.toLowerCase()));
// Sort by length DESC so longer names match first (e.g. "thinking_summary"
// before "thinking" inside the alternation).
const META_TAG_NAMES = [...META_SET].sort((a, b) => b.length - a.length);
const META_OPEN_CLOSE_RE = new RegExp(
  `<(${META_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  'gi',
);
// Generic pattern: any tag name not in PRESERVED_HTML_TAGS.
// Negative lookahead against the preserved set — too long for a literal
// regex, so we filter in the replacer callback.
const GENERIC_PAIR_RE = /<([a-z][a-z0-9-]{0,39})\b[^>]*>[\s\S]*?<\/\1>/gi;

// "Answer-wrapping" tags: when the model wraps its final reply in
// <answer>...</answer>, we want to KEEP the inner content (that's the real
// reply) and just drop the wrapper tags. Discovered 2026-08-12 — Qwen with
// output_schema='phase' commonly emits the final answer wrapped in
// <answer>...</answer> on top of the phase='answer' stream boundary.
const ANSWER_WRAPPER_RE = /<\/?(answer|response)\b[^>]*>/gi;

function stripLlmMetaTags(text: string): string {
  // Pass -1: drop orphaned conversation-structure closers (</assist>, </invoke>)
  // before wrapper/meta-tag handling so they cannot reach the answer stream.
  const structureCloseRe = new RegExp(
    `<\\/(?:${LLM_STRUCTURE_TAGS.join('|')})>`,
    'gi',
  );
  let out = text.replace(structureCloseRe, '');
  // Pass 0: drop wrappers around the final answer but preserve their content.
  out = out.replace(ANSWER_WRAPPER_RE, '');
  // Pass 1: known LLM meta tags — always stripped (including inner content).
  out = out.replace(META_OPEN_CLOSE_RE, '');
  // Pass 2: generic <word>...</word> where word is NOT a preserved HTML tag.
  out = out.replace(GENERIC_PAIR_RE, (match, name: string) =>
    PRESERVED_SET.has(name.toLowerCase()) ? match : '',
  );
  // Pass 3: drop orphaned LLM metadata closers (e.g. `</plan>`) that remain
  // after complete pairs were already stripped.
  const metaCloseRe = new RegExp(
    `</(?:${LLM_META_CLOSE_TAGS.join('|')})>`,
    'gi',
  );
  out = out.replace(metaCloseRe, '');
  return out;
}

function stripRemainingXmlMarkup(text: string): string {
  return text
    .replace(TOOL_MARKUP_RE, '')
    .replace(ENV_DETAILS_RE, '')
    .replace(NEW_TOOL_BLOCK_RE, '')
    .replace(NEW_TOOL_ORPHAN_TO_END_RE, '')
    .replace(NEW_TOOL_ORPHAN_CLOSE_RE, '')
    .replace(TOOL_RESULT_BLOCK_RE, '')
    .replace(TOOL_RESULT_ORPHAN_RE, '')
    .replace(TOOL_RESULT_TAGLESS_RE, '')
    .replace(TOOL_NAME_ORPHAN_RE, '')
    .replace(COMMAND_STDOUT_BLOCK_RE, '')
    .replace(ORPHAN_COMMAND_STDOUT_RE, '')
    .replace(/<\/(?:command|stdout|stderr)>/g, '')
    .replace(EXCESS_NEWLINES_RE, '\n\n');
}

// Strip LLM meta-tag pairs without affecting tool-call markup.
// Public export so other sanitizers (e.g. contentFilter thinking capture)
// can run the same pass on isolated segments.
export function stripUnknownXmlTags(text: string): string {
  return stripLlmMetaTags(text).replace(/\n{3,}/g, '\n\n');
}

export function cleanTextOfXmlArtifacts(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const { toolCalls, cleanedText } = parseXmlToolCalls(text);
  const fullyCleaned = stripLlmMetaTags(stripRemainingXmlMarkup(cleanedText));
  return { toolCalls, cleanedText: fullyCleaned };
}

export function xmlToolCallToParsed(
  block: ParsedXmlToolCall,
  _index: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.parameters)) {
    try {
      args[key] = JSON.parse(value);
    } catch {
      args[key] = value;
    }
  }
  const rawName = block.name;
  const name = rawName.startsWith('★-') ? rawName.slice(2) : rawName;
  return {
    id: `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}
