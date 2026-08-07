import { describe, expect, test } from 'bun:test';
import { prepareToolCallForClaude } from '../routes/anthropicConvert.ts';

const customTools = [
  {
    type: 'function',
    function: {
      name: 'Noop',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'my_tool',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
];

describe('prepareToolCallForClaude — schema-aware', () => {
  test('A: zero-arg custom tool accepted when schema declares no required args', () => {
    const r = prepareToolCallForClaude({ name: 'Noop', arguments: {} }, undefined, customTools);
    expect(r.valid).toBe(true);
    expect(r.args).toEqual({});
  });

  test('B: camelCase param preserved when declared schema uses camelCase key', () => {
    const r = prepareToolCallForClaude({ name: 'my_tool', arguments: { filePath: 'src/a.ts' } }, undefined, customTools);
    expect(r.valid).toBe(true);
    expect(r.args).toEqual({ filePath: 'src/a.ts' });
  });

  test('C: known Claude Code tool still uses camelCase table (no clientTools)', () => {
    const r = prepareToolCallForClaude({ name: 'Read', arguments: { file_path: '/x' } });
    expect(r.valid).toBe(true);
    expect(r.args.file_path).toBe('/x');
  });

  test('D: custom tool missing required field rejected', () => {
    const r = prepareToolCallForClaude({ name: 'my_tool', arguments: {} }, undefined, customTools);
    expect(r.valid).toBe(false);
  });

  test('E: Bash still works unchanged when clientTools not provided', () => {
    const r = prepareToolCallForClaude({ name: 'Bash', arguments: { command: 'pwd' } });
    expect(r.valid).toBe(true);
    expect(r.args.command).toBe('pwd');
  });
});
