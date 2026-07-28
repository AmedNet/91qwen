/**
 * Anthropic Messages ->OpenAI / Claude Code conversion helpers.
 * Kept separate from the route handler so unit tests can import without HTTP deps.
 */

import crypto from 'node:crypto';
import type { ParsedToolCall } from '../types/openai.ts';
import { camelToSnake } from '../tools/xmlToolParser.ts';

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  title?: string;
  url?: string;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export type AnthropicSystem = string | AnthropicContentBlock[];

/** Claude Code / Anthropic model id ->Qwen dotted model name. */
export const ANTHROPIC_TO_QWEN: Record<string, string> = {
  'claude-sonnet-4-20250514': 'qwen3.7-max',
  'claude-sonnet-4-20241022': 'qwen3.6-plus',
  'claude-3-5-sonnet-20241022': 'qwen3.6-plus',
  'claude-opus-4-20250514': 'qwen3.7-max',
  'claude-opus-4-8': 'qwen3.7-max',
  'claude-sonnet-4-8': 'qwen3.7-max',
  'claude-3-opus-20240229': 'qwen3.7-max',
  'claude-sonnet-4-6-20250514': 'qwen3.7-max',
  'claude-3-haiku-20240307': 'qwen3.5-flash',
  'claude-3-5-haiku-20241022': 'qwen3.5-flash',
  'claude-haiku-4-5-20251001': 'qwen3.5-flash',
  'claude-sonnet-4-5-20250929': 'qwen3.7-max',
  'claude-opus-4-1-20250805': 'qwen3.7-max',
  'claude-opus-4-5-20251101': 'qwen3.7-max',
};

export const DEFAULT_QWEN_MODEL = 'qwen3.7-max';

export function mapModel(anthropicModel: string): string {
  if (!anthropicModel) return DEFAULT_QWEN_MODEL;
  if (ANTHROPIC_TO_QWEN[anthropicModel]) return ANTHROPIC_TO_QWEN[anthropicModel];
  const lower = anthropicModel.toLowerCase();
  if (lower.includes('haiku')) return 'qwen3.5-flash';
  if (lower.includes('opus') || lower.includes('sonnet')) return 'qwen3.7-max';
  return DEFAULT_QWEN_MODEL;
}

/** Normalize Qwen / mixed-case tool names to Claude Code conventions. */
export function normalizeToolName(name: string): string {
  const stripped = name.replace(/^[^A-Za-z0-9]+-?/, '');
  const CASE_MAP: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    glob: 'Glob',
    grep: 'Grep',
    webfetch: 'WebFetch',
    web_fetch: 'WebFetch',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
    notebookedit: 'NotebookEdit',
    notebook_edit: 'NotebookEdit',
    todowrite: 'TodoWrite',
    todo_write: 'TodoWrite',
    askuserquestion: 'AskUserQuestion',
    ask_user_question: 'AskUserQuestion',
    task: 'Task',
    agent: 'Agent',
    skill: 'Skill',
  };
  return CASE_MAP[stripped.toLowerCase()] || stripped;
}

/** Build a map from normalized tool name -> original name as sent in the request tools array. */
export function buildReverseToolMap(tools?: any[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!tools || !Array.isArray(tools)) return map;
  for (const t of tools) {
    const originalName = t.function?.name || t.name;
    if (!originalName) continue;
    const normalized = normalizeToolName(originalName);
    map.set(normalized, originalName);
    // Also map the raw lowercase version for broader matching
    map.set(originalName.toLowerCase(), originalName);
  }
  return map;
}

/** Resolve a normalized tool name back to its original request name using the reverse map. */
export function resolveToolName(normalizedName: string, reverseToolMap?: Map<string, string>): string {
  if (!reverseToolMap || reverseToolMap.size === 0) return normalizedName;
  return reverseToolMap.get(normalizedName) || reverseToolMap.get(normalizedName.toLowerCase()) || normalizedName;
}

/** Map camelCase aliases to snake_case for Claude Code tool parameters. */
export function mapParamName(paramName: string): string {
  const CAMEL_TO_SNAKE: Record<string, string> = {
    filePath: 'file_path',
    oldString: 'old_string',
    newString: 'new_string',
    toolCallId: 'tool_call_id',
    replaceAll: 'replace_all',
    dryRun: 'dry_run',
    caseInsensitive: 'case_insensitive',
    outputMode: 'output_mode',
    headLimit: 'head_limit',
    maxResults: 'max_results',
    targetDirectory: 'target_directory',
    globPattern: 'glob_pattern',
    notebookPath: 'notebook_path',
  };
  // Direct lookup (already camelCase)
  const direct = CAMEL_TO_SNAKE[paramName];
  if (direct) return direct;
  // snake_case passes through unchanged
  const snaked = camelToSnake(paramName);
  if (snaked !== paramName.toLowerCase()) {
    const snakedLookup = CAMEL_TO_SNAKE[snaked];
    if (snakedLookup) return snakedLookup;
  }
  return paramName;
}

function normalizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return mapToolArgs(args);
}

/** Claude Code required params after camelCase mapping. */
export const CLAUDE_CODE_REQUIRED_PARAMS: Record<string, string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Edit: ['file_path', 'old_string', 'new_string'],
  Write: ['file_path', 'content'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  NotebookEdit: ['notebook_path'],
  TodoWrite: ['todos'],
};

export function mapToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    mapped[mapParamName(k)] = v;
  }
  return mapped;
}

export function isValidClaudeCodeToolCall(name: string, args: Record<string, unknown>): boolean {
  const required = CLAUDE_CODE_REQUIRED_PARAMS[name];
  if (required) {
    const missing = required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
    return missing.length === 0;
  }
  // Unknown tools: allow if they have at least one argument (MCP / custom tools)
  return !!args && typeof args === 'object' && Object.keys(args).length > 0;
}

export function normalizeSystemPrompt(system?: AnthropicSystem): string | undefined {
  if (system == null) return undefined;
  if (typeof system === 'string') {
    const trimmed = system.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!Array.isArray(system)) return String(system);
  const parts = system
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return b.text || '';
      return '';
    })
    .filter((s) => s.trim().length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function imageBlockToOpenAI(src: AnthropicContentBlock['source']): { type: 'image_url'; image_url: { url: string } } | null {
  if (!src) return null;
  if (src.type === 'base64' && src.media_type && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  // Anthropic uses source.url for URL images; some clients put the URL in data
  const url = (src.type === 'url' && (src.url || src.data)) || undefined;
  if (url) return { type: 'image_url', image_url: { url } };
  return null;
}

/** Flatten tool_result.content (string | content blocks) into text + optional images. */
export function flattenToolResultContent(content: string | AnthropicContentBlock[] | undefined | null): {
  text: string;
  images: Array<{ type: 'image_url'; image_url: { url: string } }>;
} {
  if (content == null) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };

  const texts: string[] = [];
  const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];

  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      texts.push(block.text || '');
    } else if (block.type === 'image') {
      const img = imageBlockToOpenAI(block.source);
      if (img) images.push(img);
      else texts.push('[image]');
    } else if (block.type === 'document') {
      const src = block.source;
      if (src?.type === 'text' && src.data) texts.push(src.data);
      else if (src?.type === 'base64') texts.push(`[document:${src.media_type || 'application/octet-stream'}]`);
      else texts.push('[document]');
    } else if (block.type === 'search_result') {
      const title = block.title || '';
      const url = block.url || '';
      const body =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n')
            : '';
      texts.push([title && `# ${title}`, url && `URL: ${url}`, body].filter(Boolean).join('\n'));
    } else if (block.text) {
      texts.push(block.text);
    } else {
      texts.push(JSON.stringify(block));
    }
  }

  return { text: texts.join('\n'), images };
}

/**
 * Convert Anthropic messages (+ optional system) to OpenAI chat messages.
 * Handles Claude Code quirks: array tool_result content, trailing text after tool results,
 * system content-block arrays, is_error, and URL images.
 */
export function anthropicMessagesToOpenAI(messages: AnthropicMessage[], system?: AnthropicSystem): any[] {
  const out: any[] = [];
  const systemText = normalizeSystemPrompt(system);
  if (systemText) {
    out.push({ role: 'system', content: systemText });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let pendingUserBlocks: any[] = [];

        const flushUserBlocks = () => {
          if (pendingUserBlocks.length === 0) return;
          if (pendingUserBlocks.length === 1 && pendingUserBlocks[0].type === 'text') {
            out.push({ role: 'user', content: pendingUserBlocks[0].text || '' });
          } else {
            out.push({ role: 'user', content: pendingUserBlocks });
          }
          pendingUserBlocks = [];
        };

        for (const block of msg.content) {
          if (block.type === 'text') {
            pendingUserBlocks.push({ type: 'text', text: block.text || '' });
          } else if (block.type === 'image') {
            const img = imageBlockToOpenAI(block.source);
            if (img) pendingUserBlocks.push(img);
          } else if (block.type === 'tool_result') {
            flushUserBlocks();
            const { text, images } = flattenToolResultContent(block.content);
            const body = block.is_error ? (text ? `[ERROR] ${text}` : '[ERROR]') : text;
            out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: body });
            if (images.length > 0) {
              out.push({ role: 'user', content: images });
            }
          } else {
            console.warn(`[Anthropic] Unknown content block: ${block.type}`);
          }
        }

        flushUserBlocks();
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text || '');
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
            });
          } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // skip ->model reasoning, not input to Qwen
          } else {
            console.warn(`[Anthropic] Unknown assistant block: ${block.type}`);
          }
        }
        const text = textParts.join('\n');
        if (toolCalls.length > 0) {
          out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
        } else {
          out.push({ role: 'assistant', content: text });
        }
      }
    }
  }
  return out;
}

export function anthropicToolsToOpenAI(tools?: any[]): any[] {
  if (!tools?.length) return [];
  return tools.map((t: any) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

export function finishReasonToAnthropic(reason: string): string {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(args[k])}`).join(',') + '}';
}

function normalizeArgsForCompare(args: unknown): Record<string, unknown> {
  let parsed: any = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return mapToolArgs(parsed as Record<string, unknown>);
}

/** True if two tool calls are the same invocation (same id, or same name+args after normalization). */
export function isDuplicateToolCall(a: ParsedToolCall, b: ParsedToolCall): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const an = normalizeToolName(a.name);
  const bn = normalizeToolName(b.name);
  if (an !== bn) return false;
  return stableArgsKey(normalizeArgsForCompare(a.arguments)) === stableArgsKey(normalizeArgsForCompare(b.arguments));
}

/**
 * Merge XML-parsed tool calls with local_mcp calls.
 * Prefer first occurrence (XML usually listed first); drop name+args duplicates even when ids differ.
 */
export function mergeParsedToolCalls(xmlCalls: ParsedToolCall[], localCalls: ParsedToolCall[]): ParsedToolCall[] {
  const merged: ParsedToolCall[] = [...xmlCalls];
  for (const ltc of localCalls) {
    if (!merged.some((e) => isDuplicateToolCall(e, ltc))) {
      merged.push(ltc);
    }
  }
  return merged;
}

export function prepareToolCallForClaude(tc: { name: string; arguments: unknown; id?: string }, reverseToolMap?: Map<string, string>): {
  valid: boolean;
  name: string;
  args: Record<string, unknown>;
} {
  let args: any = {};
  try {
    args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
  } catch {
    /* ignore */
  }
  if (!args || typeof args !== 'object') return { valid: false, name: resolveToolName(normalizeToolName(tc.name), reverseToolMap), args: {} };
  const name = normalizeToolName(tc.name);
  const mapped = normalizeToolArgs(args as Record<string, unknown>);
  return { valid: isValidClaudeCodeToolCall(name, mapped), name: resolveToolName(name, reverseToolMap), args: mapped };
}

export function convertOpenAIResponseToAnthropic(openAIResp: any, requestModel: string, reverseToolMap?: Map<string, string>): any {
  const choice = openAIResp.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      const result = prepareToolCallForClaude({ name: tc.function?.name, arguments: tc.function?.arguments, id: tc.id }, reverseToolMap);
      if (!result.valid) continue;
      content.push({ type: 'tool_use', id: tc.id, name: result.name, input: result.args });
    }
  }

  if (message.content && !content.some((c: any) => c.type === 'tool_use')) {
    content.push({ type: 'text', text: message.content });
  }

  // If tool_calls existed but all failed validation, and no text content, emit fallback
  if (message.tool_calls && message.tool_calls.length > 0 && content.length === 0) {
    const fallbackText = `[Tool call validation failed: ${message.tool_calls.length} tool call(s) were returned by the model but none passed validation. The model may have used incorrect parameter names or missing required fields. Please retry.]`;
    content.push({ type: 'text', text: fallbackText });
  }

  // Anthropic clients (Claude Code) prefer tool_use-only turns when tools are present
  if (content.length > 1 && content.some((c: any) => c.type === 'tool_use')) {
    const toolBlocks = content.filter((c: any) => c.type === 'tool_use');
    content.length = 0;
    content.push(...toolBlocks);
  }

  const hasTools = content.some((c: any) => c.type === 'tool_use');
  return {
    id: 'msg_' + crypto.randomUUID(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: openAIResp.usage?.prompt_tokens || 0, output_tokens: openAIResp.usage?.completion_tokens || 0 },
  };
}





