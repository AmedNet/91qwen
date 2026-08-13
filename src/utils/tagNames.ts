/**
 * Central registry of known XML tag names used across the stripping/parsing pipeline.
 *
 * All stripping code MUST import from this file rather than hardcoding tag names.
 * This ensures adding a new tag format requires one change (adding to an array)
 * instead of hunting down N regex patterns across the codebase.
 *
 * = Tagging format =
 *
 * Tool call tags (Qwen Studio XML format):
 *   <function=NAME>...</function>
 *   <parameter=KEY>VALUE</parameter>
 *
 * Think/reasoning tags (mark thinking blocks):
 *   <think>...</think> | <thinking>...</thinking> | <thought>...</thought>
 *
 * Tool result tags (legacy Qwen API format):
 *   <tool_result>...</tool_result>
 *   <tool_call>...</tool_call>
 *   <tool_use>...</tool_use>
 */

/** Known XML tag names for tool call blocks (function + parameter). */
export const TOOL_CALL_KEYWORDS = ['function', 'parameter'] as const;

/**
 * Newer Qwen tool-call envelope. It wraps one or more
 * `<invoke name="tool_name">` entries inside `<function_calls>`.
 */
export const FUNCTION_CALLS_TAGS = ['function_calls', 'invoke'] as const;

/** Known XML tag names for think/reasoning blocks. */
export const THINK_TAG_NAMES = ['think', 'thinking', 'thought'] as const;

/** Known XML tag names for tool result blocks (legacy format). */
export const TOOL_RESULT_KEYWORDS = ['tool_result', 'tool_call', 'tool_use'] as const;

/** Every known tool-related XML tag name (all Qwen API versions). */
export const ALL_TOOL_KEYWORDS = [...new Set([...TOOL_CALL_KEYWORDS, ...TOOL_RESULT_KEYWORDS])] as const;

/**
 * HTML/Markdown tags that must be PRESERVED when stripping unknown XML
 * blocks from LLM output. Anything in this set is treated as legitimate
 * markup (code blocks, emphasis, lists, tables, links, headings) and is
 * not stripped by the generic "<word>...</word>" pass.
 *
 * Keep this list tight — any tag added here survives the leak sanitizer
 * and reaches the client. Only add a tag if a real model emits it as
 * semantic HTML/Markdown (not as LLM metadata scaffolding).
 */
export const PRESERVED_HTML_TAGS = [
  // Code / preformatted
  'code', 'pre', 'kbd', 'samp', 'var',
  // Emphasis
  'b', 'i', 'u', 's', 'em', 'strong', 'sub', 'sup', 'small', 'mark', 'del', 'ins',
  // Structure
  'br', 'hr', 'p', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  // Links / media
  'a', 'img', 'figure', 'figcaption',
  // Quotes
  'blockquote', 'q', 'cite',
] as const;

/**
 * Known LLM metadata tag names that the Qwen model has been observed to
 * emit as part of its own internal scaffolding (often leaked into the
 * answer stream when output_schema='phase' boundaries are misaligned by
 * the upstream). Stripped aggressively along with their inner content —
 * better to lose a tag than to leak "<plan>...</plan>" verbatim.
 *
 * Note: "answer" and "response" are intentionally NOT here. When the model
 * wraps its final reply in <answer>...</answer>, we keep the inner content
 * (that IS the real reply) and only drop the wrapper tags. See
 * ANSWER_WRAPPER_RE in tools/xmlToolParser.ts.
 *
 * Source: confirmed via direct repro on qwen3.6-plus / qwen3.7-max with
 * prompts asking the model to wrap reasoning in such tags. Reproduced
 * 2026-08-12.
 */
export const LLM_META_TAGS = [
  'plan', 'purpose', 'goal',
  'context', 'step', 'analysis', 'thought', 'summary',
  'conclusion', 'reasoning', 'reflection', 'note', 'notes',
  'thinking_summary', 'thinking', 'think',
] as const;

/**
 * Structural tags from the conversation format that the model sometimes
 * echoes back into its answer stream. These are only seen as orphan closers
 * in practice, so they are stripped explicitly as closing tags.
 */

export const LLM_STRUCTURE_TAGS = ['assist', 'invoke'] as const;
/** Non-thinking LLM metadata closers that may leak as orphan tags. */
export const LLM_META_CLOSE_TAGS = LLM_META_TAGS.filter(
  (tag) => !THINK_TAG_NAMES.includes(tag as (typeof THINK_TAG_NAMES)[number]),
);
