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

/** Known XML tag names for think/reasoning blocks. */
export const THINK_TAG_NAMES = ['think', 'thinking', 'thought'] as const;

/** Known XML tag names for tool result blocks (legacy format). */
export const TOOL_RESULT_KEYWORDS = ['tool_result', 'tool-result'] as const;

/**
 * Known XML tag names that the model may accidentally leak from the system prompt.
 * These are Anthropic/Claude Code format tags that the model sometimes mimics
 * despite being instructed to use the Qwen xml_prompt format. These tags should
 * be STRIPPED during content filtering but NOT matched by the tool call parser
 * (parseXmlToolCalls only handles Qwen <function=NAME> format).
 */
export const LEAKED_TAG_KEYWORDS = ['tool_call', 'tool_use'] as const;

/** Every known tool-related XML tag name (all Qwen API versions + Anthropic leaks). */
export const ALL_TOOL_KEYWORDS = [...TOOL_CALL_KEYWORDS, ...TOOL_RESULT_KEYWORDS, ...LEAKED_TAG_KEYWORDS] as const;
