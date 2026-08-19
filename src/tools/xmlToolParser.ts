import crypto from 'node:crypto';
import { TOOL_CALL_KEYWORDS } from '../utils/tagNames.ts';

export interface ParsedXmlToolCall {
  name: string;
  parameters: Record<string, string>;
}

// ── Pre-compiled regexes for parse path ──
// Lifted to module-level to avoid recompilation on every parseXmlToolCalls() call
// (called 50-200 times per streaming request).
const FKW = TOOL_CALL_KEYWORDS[0]; // 'function' — the block-level keyword
const PKW = TOOL_CALL_KEYWORDS[1]; // 'parameter' — the parameter keyword
// Opening tag: `<keyword=NAME...>` — the header run uses [^>]* so it cannot
// span past the first `>` (the previous `[^\s>]+[\s\S]*?>` stacked two heavy
// quantifiers that could backtrack badly on adversarial input).
const FUNCTION_BLOCK_RE = new RegExp(`<${FKW}=[^\\s>]+[^>]*>[\\s\\S]*?(?:<\\/${FKW}>|$)`, 'g');
const PARAM_RE = new RegExp(`<${PKW}=([^\\s>]+)>([\\s\\S]*?)<\\/${PKW}>`, 'g');
const FUNC_NAME_RE = new RegExp(`^<${FKW}=([^\\s>]+)>`);

function functionNameFromTag(tag: string): string | null {
  // Match function name from <KEYWORD=NAME...> — NAME can be any non-whitespace, non-> chars
  const m = tag.match(FUNC_NAME_RE);
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  let cleanedText = text;

  // Fast path: skip the expensive regex exec loop when there's no tool call content
  const hasToolCallStart = TOOL_CALL_KEYWORDS.some((kw) => text.includes(`<${kw}=`));
  if (!hasToolCallStart) return { toolCalls, cleanedText };

  // Semantics: <keyword=NAME...chars...> body </keyword>
  // Matches the opening <keyword=, captures until first >, then lazily until </keyword> or end.
  FUNCTION_BLOCK_RE.lastIndex = 0;
  const re = FUNCTION_BLOCK_RE;
  const sections: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // No byte-level dedup here. Identical repeated blocks are meaningful:
    // detectParallelToolLoop (tools/guard.ts) needs to SEE ≥3 copies of the
    // same call to flag a parallel tool-call loop, and legitimately repeated
    // parallel calls must not be silently merged into one. Streaming-level
    // dedup of cumulative re-parses is the callers' job (snapshot deltas).
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
    sections.push(text.slice(lastIdx, match.index));
    lastIdx = re.lastIndex;
  }

  sections.push(text.slice(lastIdx));
  cleanedText = sections.join('');

  return { toolCalls, cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n') };
}

/**
 * Pre-compiled regexes for stripping remaining XML markup.
 * Built dynamically from the shared TOOL_CALL_KEYWORDS array so adding
 * new tool call tag keywords is a one-line change.
 */
const [TOOL_MARKUP_RE, EXCESS_NEWLINES_RE] = (() => {
  const markupParts: string[] = [];
  for (const kw of TOOL_CALL_KEYWORDS) {
    // 1. Complete block (or truncated at next occurrence of same keyword)
    markupParts.push(`<${kw}=[^\\s>][^>]*>[\\s\\S]*?(?:<\\/${kw}>|<${kw}=|$)`);
    // 2. Bare tag with =value (no >, or > at end)
    markupParts.push(`<${kw}=[^>]*(?:>|(?=\\n|$))`);
    // 3. Bare <keyword prefix followed by whitespace, <, or end
    markupParts.push(`<${kw}(?=[\\s<]|$)`);
    // 4. Opening/closing tag
    markupParts.push(`<\\/?${kw}>`);
  }
  return [new RegExp(markupParts.join('|'), 'g'), /\n{3,}/g];
})();

function stripRemainingXmlMarkup(text: string): string {
  return text.replace(TOOL_MARKUP_RE, '').replace(EXCESS_NEWLINES_RE, '\n\n');
}

export function cleanTextOfXmlArtifacts(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const { toolCalls, cleanedText } = parseXmlToolCalls(text);
  const fullyCleaned = stripRemainingXmlMarkup(cleanedText);
  return { toolCalls, cleanedText: fullyCleaned };
}

export function xmlToolCallToParsed(
  block: ParsedXmlToolCall,
  _index: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.parameters)) {
    // Only attempt JSON parsing for object/array literals and quoted strings.
    // Bare scalars ("123", "true") must stay strings — a numeric-looking file
    // path or id would otherwise silently change type (JSON.parse("123") → 123).
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
          args[key] = JSON.parse(trimmed);
          continue;
        } catch {
          /* fall through — keep the raw string */
        }
      }
    }
    args[key] = value;
  }
  const rawName = block.name;
  const name = rawName.startsWith('★-') ? rawName.slice(2) : rawName;
  return {
    id: `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}
