import { describe, expect, test } from 'bun:test';
import { extractToolEnvelope, parseToolEnvelope, toolEnvelopeClose, toolEnvelopeOpen } from './nonceToolParser.ts';

const tools = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
    },
  },
];

const nonce = '0123456789abcdef';

describe('nonceToolParser', () => {
  test('extracts a complete request-specific envelope', () => {
    const raw = `Before ${toolEnvelopeOpen(nonce)} {"tool_calls":[{"name":"Bash","arguments":{"command":"git status"}}]} ${toolEnvelopeClose(nonce)} After`;
    expect(extractToolEnvelope(raw, nonce)).toEqual({
      opened: true,
      closed: true,
      json: '{"tool_calls":[{"name":"Bash","arguments":{"command":"git status"}}]}',
      openIndex: 7,
      closeIndex: expect.any(Number),
    });
  });

  test('keeps an opener without a closer incomplete', () => {
    const result = extractToolEnvelope(`${toolEnvelopeOpen(nonce)}{"tool_calls":[]} `, nonce);
    expect(result.opened).toBe(true);
    expect(result.closed).toBe(false);
    expect(result.json).toBeUndefined();
  });

  test('accepts chunked marker content after accumulation', () => {
    const parts = [`text ${toolEnvelopeOpen(nonce).slice(0, 9)}`, `${toolEnvelopeOpen(nonce).slice(9)}{"tool_calls":[`, `{"name":"Read","arguments":{"filePath":"src/a.ts"}}]}`, toolEnvelopeClose(nonce)];
    const result = extractToolEnvelope(parts.join(''), nonce);
    expect(result.closed).toBe(true);
    expect(parseToolEnvelope(result.json!, tools).toolCalls[0].name).toBe('Read');
  });

  test('rejects an empty tool call list', () => {
    const result = parseToolEnvelope('{"tool_calls":[]}', tools);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('at least one');
  });

  test('rejects unknown names instead of producing bogus calls', () => {
    const result = parseToolEnvelope('{"tool_calls":[{"name":"Name","arguments":{}}]}', tools);
    expect(result.valid).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
  });

  test('rejects empty required values', () => {
    const result = parseToolEnvelope('{"tool_calls":[{"name":"Bash","arguments":{"command":"  "}}]}', tools);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('command');
  });

  test('rejects wrong argument types', () => {
    const result = parseToolEnvelope('{"tool_calls":[{"name":"Bash","arguments":{"command":"ls","timeoutMs":"fast"}}]}', tools);
    expect(result.valid).toBe(false);
  });

  test('requires oneOf to match exactly one branch', () => {
    const oneOfTools = [
      {
        type: 'function',
        function: {
          name: 'Choose',
          parameters: {
            type: 'object',
            properties: { value: { oneOf: [{ type: 'number' }, { type: 'integer' }] } },
            required: ['value'],
          },
        },
      },
    ];
    const result = parseToolEnvelope('{"tool_calls":[{"name":"Choose","arguments":{"value":1}}]}', oneOfTools);
    expect(result.valid).toBe(false);
  });

  test('ignores model-supplied call IDs', () => {
    const result = parseToolEnvelope('{"tool_calls":[{"id":"attacker-id","name":"Bash","arguments":{"command":"pwd"}}]}', tools);
    expect(result.valid).toBe(true);
    expect(result.toolCalls[0].id).toMatch(/^call_/);
    expect(result.toolCalls[0].id).not.toBe('attacker-id');
  });

  test('aligns model argument casing to the registered schema', () => {
    const result = parseToolEnvelope('{"tool_calls":[{"name":"Read","arguments":{"file_path":"src/a.ts"}}]}', tools);
    expect(result.valid).toBe(true);
    expect(result.toolCalls[0].arguments).toEqual({ filePath: 'src/a.ts' });
  });

  test('does not interpret ordinary code markup without the exact nonce', () => {
    const raw = 'const example = "<<<QG_TOOL_deadbeef>>>"; <function=Name>';
    expect(extractToolEnvelope(raw, nonce).opened).toBe(false);
  });
});
