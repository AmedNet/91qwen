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
const FUNCTION_BLOCK_RE = new RegExp(`<${FKW}=[^\\s>]+[\\s\\S]*?>[\\s\\S]*?<\\/${FKW}>`, 'g');
const PARAM_RE = new RegExp(`<${PKW}=([^\\s>]+)>([\\s\\S]*?)<\\/${PKW}>`, 'g');
const FUNC_NAME_RE = new RegExp(`^<${FKW}=([^\\s>]+)>`);

function functionNameFromTag(tag: string): string | null {
  // Match function name from <KEYWORD=NAME...> — NAME can be any non-whitespace, non-> chars
  const m = tag.match(FUNC_NAME_RE);
  return m ? m[1] : null;
}

export function parseXmlToolCalls(text: string): { toolCalls: ParsedXmlToolCall[]; cleanedText: string } {
  const toolCalls: ParsedXmlToolCall[] = [];
  const unique = new Set<string>();
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

/**
 * Qwen models often forget underscores in snake_case parameter names
 * (e.g. "filepath" instead of "file_path", "oldstring" instead of "old_string").
 * This map re-canonicalizes known mistakes before the tool call is emitted to the client.
 */
export const PARAM_NAME_FIXUPS: Record<string, string> = {
  filepath: 'file_path',
  newstring: 'new_string',
  oldstring: 'old_string',
  toolcallid: 'tool_call_id',
  replaceall: 'replace_all',
  dryrun: 'dry_run',
  caseinsensitive: 'case_insensitive',
  outputmode: 'output_mode',
  headlimit: 'head_limit',
  maxresults: 'max_results',
  notebookpath: 'notebook_path',
  targetdirectory: 'target_directory',
  globpattern: 'glob_pattern',
  alloweddomains: 'allowed_domains',
  blockeddomains: 'blocked_domains',
  subagenttype: 'subagent_type',
  runinbackground: 'run_in_background',
  cellid: 'cell_id',
  newsource: 'new_source',
  editmode: 'edit_mode',
  celltype: 'cell_type',
  dangerouslydisablesandbox: 'dangerouslyDisableSandbox',
  notebookPath: 'notebookPath',
};

/** Known canonical parameter names for Claude Code tools.
 *  Single source of truth — imported by chatStreamingHelpers.ts.
 *  Covers all Claude Code agent tool parameters. */
export const CANONICAL_PARAM_NAMES = [
  // Edit / Write / Read
  'file_path', 'old_string', 'new_string', 'content',
  'offset', 'limit', 'pages',
  // Bash
  'command', 'description', 'dangerouslyDisableSandbox', 'timeout', 'run_in_background',
  // Glob / Grep
  'pattern', 'path', 'glob_pattern', 'output_mode', 'head_limit',
  // WebFetch / WebSearch
  'url', 'prompt', 'query', 'allowed_domains', 'blocked_domains',
  // Task / Agent
  'subagent_type', 'model',
  // NotebookEdit
  'notebook_path', 'notebookPath', 'cell_id', 'new_source', 'edit_mode', 'cell_type',
  // TodoWrite
  'todos',
  // Generic / cross-cutting
  'tool_call_id', 'replace_all', 'dry_run', 'case_insensitive',
  'max_results', 'target_directory',
];

/**
 * Convert camelCase to snake_case at word boundaries.
 * "outputMode" → "output_mode", "notebookPath" → "notebook_path"
 */
export function camelToSnake(s: string): string {
  // Preserve ALL_CAPS tokens (e.g. "JSON", "URL", "MCP")
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function fixupParamName(key: string): string {
  const lowered = key.toLowerCase();
  // 1. Direct lookup in known fixups
  const fixed = PARAM_NAME_FIXUPS[lowered];
  if (fixed) return fixed;
  // 2. camelCase → snake_case conversion (e.g. "outputMode" → "output_mode")
  const snaked = camelToSnake(key);
  if (snaked !== lowered) {
    const snakedFixed = PARAM_NAME_FIXUPS[snaked.toLowerCase()];
    if (snakedFixed) return snakedFixed;
    // Check if the snaked version matches a canonical name directly
    for (const canonical of CANONICAL_PARAM_NAMES) {
      if (canonical === snaked) return canonical;
    }
  }
  // 3. Fuzzy match: normalize by removing underscores and compare
  const normalized = lowered.replace(/_/g, '');
  for (const canonical of CANONICAL_PARAM_NAMES) {
    if (canonical.toLowerCase().replace(/_/g, '') === normalized) {
      return canonical;
    }
  }
  // 4. If snaked version differs from original and wasn't caught above, return snaked
  if (snaked !== lowered) return snaked;
  return key;
}

export function xmlToolCallToParsed(
  block: ParsedXmlToolCall,
  _index: number,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.parameters)) {
    const fixedKey = fixupParamName(key);
    try {
      args[fixedKey] = JSON.parse(value);
    } catch {
      args[fixedKey] = value;
    }
  }
  const rawName = block.name;
  const name = rawName.replace(/^[^A-Za-z0-9]+-?/, '');
  return {
    id: `call_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}

/** Normalize a key for fuzzy matching: lowercase + strip underscores. */
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/_/g, '');
}

/**
 * Align a tool call's argument names to the client-registered tool schema.
 * The keys in schema `properties` are the authoritative param names for that
 * tool (camelCase or snake_case, depending on the client). Model output param
 * names are matched by normalized form (lowercase, underscores stripped) against
 * the schema keys; a hit rewrites the key to the schema's real casing. Unmatched
 * keys are preserved as-is (fallback to fixupParamName's snake_case result).
 *
 * When `tools` is empty/absent, returns `args` unchanged so no-schema callers
 * keep their existing behavior.
 */
export function alignArgsToSchema(
  toolName: string,
  args: Record<string, unknown>,
  tools?: any[],
): Record<string, unknown> {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return args;
  const tool = tools.find((t: any) => (t.function?.name || t.name) === toolName);
  const props = tool?.function?.parameters?.properties;
  if (!props || typeof props !== 'object') return args;

  const schemaEntries = Object.keys(props).map((k) => ({ orig: k, norm: normalizeKey(k) }));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const norm = normalizeKey(k);
    const hit = schemaEntries.find((e) => e.norm === norm);
    out[hit ? hit.orig : k] = v;
  }
  return out;
}
