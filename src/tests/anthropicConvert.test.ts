// Tests for real exported functions from anthropicConvert.ts
import { describe, expect, test } from 'bun:test';
import {
  buildReverseToolMap,
  resolveToolName,
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  convertOpenAIResponseToAnthropic,
  flattenToolResultContent,
  isDuplicateToolCall,
  mapModel,
  mapParamName,
  mapToolArgs,
  mergeParsedToolCalls,
  normalizeSystemPrompt,
  normalizeToolName,
  prepareToolCallForClaude,
} from '../routes/anthropicConvert.ts';

// ── normalizeSystemPrompt ──────────────────────────────────────────

describe('normalizeSystemPrompt', () => {
  test('returns undefined for null/undefined', () => {
    expect(normalizeSystemPrompt(undefined)).toBeUndefined();
    expect(normalizeSystemPrompt(null as any)).toBeUndefined();
  });

  test('returns trimmed string for string input', () => {
    expect(normalizeSystemPrompt('  hello  ')).toBe('hello');
    expect(normalizeSystemPrompt('')).toBeUndefined();
    expect(normalizeSystemPrompt('   ')).toBeUndefined();
  });

  test('joins text blocks from array', () => {
    const sys = [
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'Be concise.' },
    ];
    expect(normalizeSystemPrompt(sys)).toBe('You are helpful.\nBe concise.');
  });

  test('skips empty text blocks', () => {
    const sys = [{ type: 'text', text: '' }, { type: 'text', text: 'Hi' }];
    expect(normalizeSystemPrompt(sys)).toBe('Hi');
  });

  test('handles mixed string and block entries', () => {
    const sys = ['plain text', { type: 'text', text: 'block text' }] as any;
    expect(normalizeSystemPrompt(sys)).toBe('plain text\nblock text');
  });
});

// ── flattenToolResultContent ───────────────────────────────────────

describe('flattenToolResultContent', () => {
  test('handles null/undefined/empty', () => {
    expect(flattenToolResultContent(null)).toEqual({ text: '', images: [] });
    expect(flattenToolResultContent(undefined)).toEqual({ text: '', images: [] });
  });

  test('handles plain string', () => {
    expect(flattenToolResultContent('hello')).toEqual({ text: 'hello', images: [] });
  });

  test('flattens text + image blocks', () => {
    const content = [
      { type: 'text', text: 'result' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ];
    const r = flattenToolResultContent(content);
    expect(r.text).toBe('result');
    expect(r.images.length).toBe(1);
    expect(r.images[0].image_url.url).toBe('data:image/png;base64,abc');
  });

  test('handles URL source images', () => {
    const content = [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }];
    const r = flattenToolResultContent(content);
    expect(r.images.length).toBe(1);
    expect(r.images[0].image_url.url).toBe('https://example.com/img.png');
  });

  test('handles document blocks (text source)', () => {
    const content = [{ type: 'document', source: { type: 'text', data: 'doc content' } }];
    const r = flattenToolResultContent(content);
    expect(r.text).toBe('doc content');
  });

  test('handles document blocks (base64 source)', () => {
    const content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } }];
    const r = flattenToolResultContent(content);
    expect(r.text).toBe('[document:application/pdf]');
  });

  test('handles search_result blocks', () => {
    const content = [{ type: 'search_result', title: 'Title', url: 'https://x.com', content: 'body text' }];
    const r = flattenToolResultContent(content);
    expect(r.text).toContain('# Title');
    expect(r.text).toContain('URL: https://x.com');
    expect(r.text).toContain('body text');
  });

  test('handles search_result with array content', () => {
    const content = [{ type: 'search_result', title: 'T', url: 'https://x.com', content: [{ text: 'part1' }, { text: 'part2' }] }] as any;
    const r = flattenToolResultContent(content);
    expect(r.text).toContain('part1');
    expect(r.text).toContain('part2');
  });
});

// ── anthropicMessagesToOpenAI ──────────────────────────────────────

describe('anthropicMessagesToOpenAI', () => {
  test('converts system as array to system message', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const sys = [{ type: 'text', text: 'Be helpful' }];
    const out = anthropicMessagesToOpenAI(msgs, sys);
    expect(out[0]).toEqual({ role: 'system', content: 'Be helpful' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('converts system as string', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const out = anthropicMessagesToOpenAI(msgs, 'You are a helper');
    expect(out[0]).toEqual({ role: 'system', content: 'You are a helper' });
  });

  test('handles tool_result with is_error', () => {
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content: 'command failed' }],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].role).toBe('tool');
    expect(out[0].content).toBe('[ERROR] command failed');
  });

  test('handles tool_result with is_error and no content', () => {
    const msgs = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true }],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].content).toBe('[ERROR]');
  });

  test('handles tool_result with array content (text + image)', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'screenshot taken' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } },
            ],
          },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    // tool message with text
    expect(out[0].role).toBe('tool');
    expect(out[0].content).toBe('screenshot taken');
    // trailing user message with image
    expect(out[1].role).toBe('user');
    expect(Array.isArray(out[1].content)).toBe(true);
    expect(out[1].content[0].type).toBe('image_url');
  });

  test('preserves user text before and after tool_result blocks', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
          { type: 'text', text: 'after' },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ role: 'user', content: 'before' });
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'done' });
    expect(out[2]).toEqual({ role: 'user', content: 'after' });
  });

  test('preserves trailing text after tool_result', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'done' },
          { type: 'text', text: 'please continue' },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].role).toBe('tool');
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe('please continue');
  });

  test('handles user message with inline image (no tool_result)', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'img' } },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].role).toBe('user');
    expect(Array.isArray(out[0].content)).toBe(true);
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'what is this?' });
    expect(out[0].content[1].type).toBe('image_url');
  });

  test('handles URL image in user message', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/pic.png' } },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/pic.png' } });
  });

  test('skips thinking/redacted_thinking blocks in assistant', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'redacted_thinking', data: 'secret' },
          { type: 'text', text: 'Here is the answer' },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].content).toBe('Here is the answer');
  });

  test('handles assistant with tool_use blocks', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    ];
    const out = anthropicMessagesToOpenAI(msgs);
    expect(out[0].role).toBe('assistant');
    expect(out[0].content).toBe('Let me check');
    expect(out[0].tool_calls).toBeDefined();
    expect(out[0].tool_calls[0].id).toBe('call_1');
    expect(out[0].tool_calls[0].function.name).toBe('Bash');
    expect(out[0].tool_calls[0].function.arguments).toBe('{"command":"ls"}');
  });
});

// ── mergeParsedToolCalls ───────────────────────────────────────────

describe('mergeParsedToolCalls', () => {
  test('deduplicates by name+args even when IDs differ', () => {
    const xml = [{ id: 'call_xml', name: 'Bash', arguments: { command: 'ls' } }];
    const local = [{ id: 'call_mcp', name: 'Bash', arguments: { command: 'ls' } }];
    const merged = mergeParsedToolCalls(xml, local);
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe('call_xml');
  });

  test('keeps distinct tool calls', () => {
    const xml = [{ id: 'call_1', name: 'Bash', arguments: { command: 'ls' } }];
    const local = [{ id: 'call_2', name: 'Read', arguments: { file_path: '/tmp/x' } }];
    const merged = mergeParsedToolCalls(xml, local);
    expect(merged.length).toBe(2);
  });

  test('deduplicates after snake_case normalization', () => {
    const xml = [{ id: 'call_1', name: 'Edit', arguments: { file_path: '/x', old_string: 'a', new_string: 'b' } }];
    const local = [{ id: 'call_2', name: 'Edit', arguments: { filePath: '/x', oldString: 'a', newString: 'b' } }];
    const merged = mergeParsedToolCalls(xml, local);
    expect(merged.length).toBe(1);
  });

  test('deduplicates by ID even with different names', () => {
    const xml = [{ id: 'call_same', name: 'Bash', arguments: { command: 'ls' } }];
    const local = [{ id: 'call_same', name: 'Read', arguments: { filePath: '/x' } }];
    const merged = mergeParsedToolCalls(xml, local);
    expect(merged.length).toBe(1);
    expect(merged[0].name).toBe('Bash');
  });

  test('keeps same-name tools with different args', () => {
    const xml = [{ id: 'call_1', name: 'Bash', arguments: { command: 'ls' } }];
    const local = [{ id: 'call_2', name: 'Bash', arguments: { command: 'pwd' } }];
    const merged = mergeParsedToolCalls(xml, local);
    expect(merged.length).toBe(2);
  });

  test('handles empty inputs', () => {
    expect(mergeParsedToolCalls([], [])).toEqual([]);
    const xml = [{ id: 'call_1', name: 'Bash', arguments: { command: 'ls' } }];
    expect(mergeParsedToolCalls(xml, [])).toEqual(xml);
    expect(mergeParsedToolCalls([], xml).length).toBe(1);
  });
});

// ── prepareToolCallForClaude ───────────────────────────────────────

describe('prepareToolCallForClaude', () => {
  test('validates Bash with command', () => {
    const r = prepareToolCallForClaude({ name: 'Bash', arguments: { command: 'ls' } });
    expect(r.valid).toBe(true);
    expect(r.name).toBe('Bash');
    expect(r.args).toEqual({ command: 'ls' });
  });

  test('rejects Bash without command', () => {
    const r = prepareToolCallForClaude({ name: 'Bash', arguments: { description: 'list' } });
    expect(r.valid).toBe(false);
  });

  test('keeps snake_case for file tools', () => {
    const r = prepareToolCallForClaude({
      name: 'Edit',
      arguments: { file_path: '/x', old_string: 'a', new_string: 'b' },
    });
    expect(r.valid).toBe(true);
    expect(r.args).toEqual({ file_path: '/x', old_string: 'a', new_string: 'b' });
  });

  test('normalizes lowercase tool name', () => {
    const r = prepareToolCallForClaude({ name: 'bash', arguments: { command: 'ls' } });
    expect(r.name).toBe('Bash');
    expect(r.valid).toBe(true);
  });

  test('handles string arguments (JSON)', () => {
    const r = prepareToolCallForClaude({ name: 'Read', arguments: '{"file_path":"/tmp/x"}' });
    expect(r.valid).toBe(true);
    expect(r.args).toEqual({ file_path: '/tmp/x' });
  });

  test('handles invalid JSON arguments gracefully', () => {
    const r = prepareToolCallForClaude({ name: 'Bash', arguments: 'not-json' });
    expect(r.valid).toBe(false);
  });

  test('unknown tool passes with any non-empty args', () => {
    const r = prepareToolCallForClaude({ name: 'CustomTool', arguments: { foo: 'bar' } });
    expect(r.valid).toBe(true);
  });

  test('unknown tool fails with empty args', () => {
    const r = prepareToolCallForClaude({ name: 'CustomTool', arguments: {} });
    expect(r.valid).toBe(false);
  });

  test('validates Write with filePath + content', () => {
    const r = prepareToolCallForClaude({ name: 'Write', arguments: { file_path: '/out.txt', content: 'hello' } });
    expect(r.valid).toBe(true);
  });

  test('rejects Write missing content', () => {
    const r = prepareToolCallForClaude({ name: 'Write', arguments: { filePath: '/out.txt' } });
    expect(r.valid).toBe(false);
  });

  test('validates Glob with pattern', () => {
    const r = prepareToolCallForClaude({ name: 'Glob', arguments: { pattern: '**/*.ts' } });
    expect(r.valid).toBe(true);
  });

  test('validates Grep with pattern', () => {
    const r = prepareToolCallForClaude({ name: 'Grep', arguments: { pattern: 'TODO' } });
    expect(r.valid).toBe(true);
  });
});

// ── convertOpenAIResponseToAnthropic ───────────────────────────────

describe('convertOpenAIResponseToAnthropic', () => {
  test('converts text-only response', () => {
    const resp = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.role).toBe('assistant');
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).toBe('Hello');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.model).toBe('claude-sonnet-4-20250514');
  });

  test('converts tool_calls and drops text when tools present', () => {
    const resp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Let me run that',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content.every((c: any) => c.type === 'tool_use')).toBe(true);
    expect(out.content[0].name).toBe('Bash');
    expect(out.content[0].input).toEqual({ command: 'ls' });
  });

  test('filters invalid tool calls', () => {
    const resp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
              { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/x"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.content.length).toBe(1);
    expect(out.content[0].name).toBe('Read');
    expect(out.content[0].input).toEqual({ file_path: '/x' });
  });

  test('returns end_turn with fallback text when all tool calls filtered', () => {
    const resp = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.stop_reason).toBe('end_turn');
    expect(out.content.length).toBe(1);
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).toContain('Tool call validation failed');
  });

  test('preserves usage info', () => {
    const resp = {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.usage.input_tokens).toBe(100);
    expect(out.usage.output_tokens).toBe(50);
  });
});

// ── mapModel ───────────────────────────────────────────────────────

describe('mapModel', () => {
  test('maps known Claude models', () => {
    expect(mapModel('claude-sonnet-4-20250514')).toBe('qwen3.7-max');
    expect(mapModel('claude-3-5-haiku-20241022')).toBe('qwen3.5-flash');
    expect(mapModel('claude-opus-4-20250514')).toBe('qwen3.7-max');
  });

  test('falls back by keyword', () => {
    expect(mapModel('claude-opus-99')).toBe('qwen3.7-max');
    expect(mapModel('claude-haiku-future')).toBe('qwen3.5-flash');
    expect(mapModel('claude-sonnet-future')).toBe('qwen3.7-max');
  });

  test('returns default for unknown/empty', () => {
    expect(mapModel('')).toBe('qwen3.7-max');
    expect(mapModel('gpt-4')).toBe('qwen3.7-max');
  });
});

// ── anthropicToolsToOpenAI ─────────────────────────────────────────

describe('anthropicToolsToOpenAI', () => {
  test('converts Anthropic tool format to OpenAI format', () => {
    const tools = [
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    ];
    const converted = anthropicToolsToOpenAI(tools);
    expect(converted.length).toBe(1);
    expect(converted[0].type).toBe('function');
    expect(converted[0].function.name).toBe('Bash');
    expect(converted[0].function.parameters.required).toEqual(['command']);
  });

  test('returns empty array for no tools', () => {
    expect(anthropicToolsToOpenAI([])).toEqual([]);
    expect(anthropicToolsToOpenAI(undefined)).toEqual([]);
  });

  test('uses empty schema when input_schema missing', () => {
    const tools = [{ name: 'Test', description: 'A test tool' }];
    const converted = anthropicToolsToOpenAI(tools);
    expect(converted[0].function.parameters).toEqual({ type: 'object', properties: {} });
  });
});

// ── normalizeToolName ──────────────────────────────────────────────

describe('normalizeToolName', () => {
  test('normalizes known tool names to PascalCase', () => {
    expect(normalizeToolName('bash')).toBe('Bash');
    expect(normalizeToolName('read')).toBe('Read');
    expect(normalizeToolName('edit')).toBe('Edit');
    expect(normalizeToolName('write')).toBe('Write');
    expect(normalizeToolName('glob')).toBe('Glob');
    expect(normalizeToolName('grep')).toBe('Grep');
  });

  test('strips noisy prefix', () => {
    expect(normalizeToolName('★-Bash')).toBe('Bash');
    expect(normalizeToolName('★-Read')).toBe('Read');
  });

  test('passes through unknown names unchanged', () => {
    expect(normalizeToolName('CustomTool')).toBe('CustomTool');
    expect(normalizeToolName('my_tool')).toBe('my_tool');
  });
});

// ── mapParamName / mapToolArgs ─────────────────────────────────────

describe('mapParamName / mapToolArgs', () => {
  test('maps camelCase to snake_case', () => {
    expect(mapParamName('filePath')).toBe('file_path');
    expect(mapParamName('oldString')).toBe('old_string');
    expect(mapParamName('newString')).toBe('new_string');
    expect(mapParamName('toolCallId')).toBe('tool_call_id');
  });

  test('passes through snake_case unchanged', () => {
    expect(mapParamName('file_path')).toBe('file_path');
    expect(mapParamName('old_string')).toBe('old_string');
    expect(mapParamName('output_mode')).toBe('output_mode');
  });

  test('passes through unmapped names', () => {
    expect(mapParamName('command')).toBe('command');
    expect(mapParamName('content')).toBe('content');
  });

  test('mapToolArgs maps all keys', () => {
    const args = { filePath: '/x', oldString: 'a', command: 'ls' };
    const mapped = mapToolArgs(args);
    expect(mapped).toEqual({ file_path: '/x', old_string: 'a', command: 'ls' });
  });

  test('mapToolArgs preserves snake_case keys', () => {
    const args = { file_path: '/x', old_string: 'a', command: 'ls' };
    const mapped = mapToolArgs(args);
    expect(mapped).toEqual({ file_path: '/x', old_string: 'a', command: 'ls' });
  });

  test('Grep with outputMode gets normalized to output_mode', () => {
    const args = { pattern: 'TODO', outputMode: 'content', headLimit: 10 };
    const mapped = mapToolArgs(args);
    expect(mapped).toEqual({ pattern: 'TODO', output_mode: 'content', head_limit: 10 });
  });
});

// ── isDuplicateToolCall ────────────────────────────────────────────

describe('isDuplicateToolCall', () => {
  test('matches by ID', () => {
    const a = { id: 'call_1', name: 'Bash', arguments: { command: 'ls' } };
    const b = { id: 'call_1', name: 'Read', arguments: { filePath: '/x' } };
    expect(isDuplicateToolCall(a as any, b as any)).toBe(true);
  });

  test('matches by name+args after normalization', () => {
    const a = { id: 'call_1', name: 'Edit', arguments: { file_path: '/x', old_string: 'a', new_string: 'b' } };
    const b = { id: 'call_2', name: 'Edit', arguments: { filePath: '/x', oldString: 'a', newString: 'b' } };
    expect(isDuplicateToolCall(a as any, b as any)).toBe(true);
  });

  test('does not match different args', () => {
    const a = { id: 'call_1', name: 'Bash', arguments: { command: 'ls' } };
    const b = { id: 'call_2', name: 'Bash', arguments: { command: 'pwd' } };
    expect(isDuplicateToolCall(a as any, b as any)).toBe(false);
  });

  test('does not match different names', () => {
    const a = { id: 'call_1', name: 'Bash', arguments: { command: 'ls' } };
    const b = { id: 'call_2', name: 'Read', arguments: { command: 'ls' } };
    expect(isDuplicateToolCall(a as any, b as any)).toBe(false);
  });
});

// -- buildReverseToolMap --------------------------------------------------

describe('buildReverseToolMap', () => {
  test('builds map from OpenAI-format tools', () => {
    const tools = [
      { type: 'function', function: { name: 'Bash', parameters: {} } },
      { type: 'function', function: { name: 'Read', parameters: {} } },
    ];
    const map = buildReverseToolMap(tools);
    expect(map.get('Bash')).toBe('Bash');
    expect(map.get('Read')).toBe('Read');
  });

  test('maps normalized name back to original', () => {
    const tools = [
      { type: 'function', function: { name: 'bash', parameters: {} } },
      { type: 'function', function: { name: 'read', parameters: {} } },
    ];
    const map = buildReverseToolMap(tools);
    expect(map.get('Bash')).toBe('bash');
    expect(map.get('Read')).toBe('read');
  });

  test('handles Anthropic-format tools (name field)', () => {
    const tools = [
      { name: 'Bash', description: 'Run command', input_schema: {} },
    ];
    const map = buildReverseToolMap(tools);
    expect(map.get('Bash')).toBe('Bash');
  });

  test('returns empty map for undefined/empty', () => {
    expect(buildReverseToolMap(undefined).size).toBe(0);
    expect(buildReverseToolMap([]).size).toBe(0);
  });

  test('skips tools without name', () => {
    const tools = [{ type: 'function', function: { parameters: {} } }];
    const map = buildReverseToolMap(tools as any);
    expect(map.size).toBe(0);
  });

  test('maps lowercase original for broader matching', () => {
    const tools = [
      { type: 'function', function: { name: 'Bash', parameters: {} } },
    ];
    const map = buildReverseToolMap(tools);
    expect(map.get('bash')).toBe('Bash');
  });
});

// -- resolveToolName -------------------------------------------------------

describe('resolveToolName', () => {
  test('returns original name when map is undefined', () => {
    expect(resolveToolName('Bash')).toBe('Bash');
  });

  test('returns original name when map is empty', () => {
    expect(resolveToolName('Bash', new Map())).toBe('Bash');
  });

  test('resolves from map', () => {
    const map = new Map([['Bash', 'mcp__server__Bash']]);
    expect(resolveToolName('Bash', map)).toBe('mcp__server__Bash');
  });

  test('falls back to normalized name when not in map', () => {
    const map = new Map([['Read', 'Read']]);
    expect(resolveToolName('Bash', map)).toBe('Bash');
  });

  test('falls back to lowercase lookup', () => {
    const map = new Map([['bash', 'my_bash_tool']]);
    expect(resolveToolName('Bash', map)).toBe('my_bash_tool');
  });
});

// -- prepareToolCallForClaude with reverseToolMap --------------------------

describe('prepareToolCallForClaude with reverseToolMap', () => {
  test('resolves tool name using reverseToolMap', () => {
    const map = new Map([['Bash', 'mcp__tools__Bash']]);
    const r = prepareToolCallForClaude({ name: 'bash', arguments: { command: 'ls' } }, map);
    expect(r.valid).toBe(true);
    expect(r.name).toBe('mcp__tools__Bash');
  });

  test('works without reverseToolMap (backward compat)', () => {
    const r = prepareToolCallForClaude({ name: 'bash', arguments: { command: 'ls' } });
    expect(r.valid).toBe(true);
    expect(r.name).toBe('Bash');
  });

  test('resolves invalid tool call name too', () => {
    const map = new Map([['Bash', 'original_bash']]);
    const r = prepareToolCallForClaude({ name: 'bash', arguments: 'not-json' }, map);
    expect(r.valid).toBe(false);
    expect(r.name).toBe('original_bash');
  });
});

// -- convertOpenAIResponseToAnthropic with reverseToolMap -----------------

describe('convertOpenAIResponseToAnthropic with reverseToolMap', () => {
  test('uses reverseToolMap to resolve tool names in response', () => {
    const resp = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          ],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const map = new Map([['Bash', 'custom_Bash']]);
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514', map);
    expect(out.content[0].name).toBe('custom_Bash');
  });

  test('works without reverseToolMap (backward compat)', () => {
    const resp = {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          ],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const out = convertOpenAIResponseToAnthropic(resp, 'claude-sonnet-4-20250514');
    expect(out.content[0].name).toBe('Bash');
  });
});
