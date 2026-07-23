// Unit tests for alignArgsToSchema — aligns tool-call arg names to client schema casing.

import { describe, expect, test } from 'bun:test';
import { alignArgsToSchema } from '../tools/xmlToolParser.ts';

// Helpers to build OpenAI-style tool schemas with given parameter casing.
const camelReadTool = {
  type: 'function',
  function: {
    name: 'Read',
    parameters: { type: 'object', properties: { filePath: {}, offset: {}, limit: {} }, required: ['filePath'] },
  },
};
const snakeReadTool = {
  type: 'function',
  function: {
    name: 'Read',
    parameters: { type: 'object', properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] },
  },
};
const grepTool = {
  type: 'function',
  function: {
    name: 'Grep',
    parameters: { type: 'object', properties: { pattern: {}, outputMode: {}, headLimit: {} }, required: ['pattern'] },
  },
};

describe('alignArgsToSchema', () => {
  test('snake_case model output -> camelCase schema keys', () => {
    // Model output after fixupParamName is snake_case; client schema wants camelCase.
    const out = alignArgsToSchema('Read', { file_path: '/x', offset: 1, limit: 10 }, [camelReadTool]);
    expect(out).toEqual({ filePath: '/x', offset: 1, limit: 10 });
  });

  test('camelCase model output -> snake_case schema keys', () => {
    const out = alignArgsToSchema('Read', { filePath: '/x', offset: 1, limit: 10 }, [snakeReadTool]);
    expect(out).toEqual({ file_path: '/x', offset: 1, limit: 10 });
  });

  test('model typo "filepath" aligns to schema key (camel)', () => {
    const out = alignArgsToSchema('Read', { filepath: '/x' }, [camelReadTool]);
    expect(out).toEqual({ filePath: '/x' });
  });

  test('model typo "filepath" aligns to schema key (snake)', () => {
    const out = alignArgsToSchema('Read', { filepath: '/x' }, [snakeReadTool]);
    expect(out).toEqual({ file_path: '/x' });
  });

  test('outputMode typo -> camelCase schema key', () => {
    // Model emitted snake_case output_mode; client Grep schema wants outputMode.
    const out = alignArgsToSchema('Grep', { pattern: 'TODO', output_mode: 'content', head_limit: 10 }, [grepTool]);
    expect(out).toEqual({ pattern: 'TODO', outputMode: 'content', headLimit: 10 });
  });

  test('no tools -> args unchanged (fallback)', () => {
    expect(alignArgsToSchema('Read', { filePath: '/x' }, undefined)).toEqual({ filePath: '/x' });
    expect(alignArgsToSchema('Read', { filePath: '/x' }, [])).toEqual({ filePath: '/x' });
  });

  test('tool not in schema -> args unchanged (fallback)', () => {
    expect(alignArgsToSchema('Unknown', { filePath: '/x' }, [camelReadTool])).toEqual({ filePath: '/x' });
  });

  test('tool with no parameters.properties -> args unchanged', () => {
    const noProps = { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } };
    expect(alignArgsToSchema('Read', { filePath: '/x' }, [noProps])).toEqual({ filePath: '/x' });
  });

  test('args key not declared in schema -> preserved as-is (extra param kept)', () => {
    // An arg the schema never declared keeps the model's (fixup'd) key, so it isn't silently dropped.
    const out = alignArgsToSchema('Read', { file_path: '/x', mystery_param: 1 }, [snakeReadTool]);
    expect(out).toEqual({ file_path: '/x', mystery_param: 1 });
  });
});
