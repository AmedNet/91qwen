import { describe, it } from 'bun:test';
import { strict as assert } from 'node:assert';
import type { ParsedToolCall } from '../types/openai.ts';
import { detectParallelToolLoop, readToolCall, validateSingleToolCall } from './guard.ts';

describe('validateSingleToolCall', () => {
  it('should accept valid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'single', name: 'test', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(result.ok);
  });

  it('should reject invalid single tool call', () => {
    const toolCall: ParsedToolCall = { id: 'bad', name: '', arguments: {} };
    const result = validateSingleToolCall(toolCall);
    assert.ok(!result.ok);
  });

  it('accepts OpenAI-nested shape (function.name / function.arguments string)', () => {
    const nested = {
      id: 'n1',
      type: 'function',
      function: { name: 'Bash', arguments: '{"command":"ls /tmp"}' },
    };
    const result = validateSingleToolCall(nested as unknown as ParsedToolCall);
    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  });

  it('rejects nested shape with empty function.name', () => {
    const nested = {
      id: 'n2',
      type: 'function',
      function: { name: '', arguments: '{}' },
    };
    const result = validateSingleToolCall(nested as unknown as ParsedToolCall);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => /missing or has invalid "name"/.test(e)));
  });

  it('rejects nested shape with malformed function.arguments JSON', () => {
    const nested = {
      id: 'n3',
      type: 'function',
      function: { name: 'Bash', arguments: 'not-json' },
    };
    const result = validateSingleToolCall(nested as unknown as ParsedToolCall);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => /has non-object arguments/.test(e)));
  });

  it('readToolCall parses nested function.arguments JSON string back to object', () => {
    const nested = {
      id: 'n4',
      type: 'function',
      function: { name: 'Bash', arguments: '{"command":"pwd"}' },
    };
    const out = readToolCall(nested);
    assert.equal(out.name, 'Bash');
    assert.deepEqual(out.arguments, { command: 'pwd' });
  });

  it('readToolCall returns flat fields when given flat shape', () => {
    const flat: ParsedToolCall = { id: 'f1', name: 'Bash', arguments: { command: 'pwd' } };
    const out = readToolCall(flat);
    assert.equal(out.name, 'Bash');
    assert.deepEqual(out.arguments, { command: 'pwd' });
  });
});

describe('detectParallelToolLoop', () => {
  it('should pass with single tool call', () => {
    const tcs: ParsedToolCall[] = [{ id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } }];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });

  it('should pass with different tool calls', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'read_file', arguments: { path: '/tmp/x' } },
      { id: 't2', name: 'bash', arguments: { command: 'ls' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });

  it('should detect parallel loop with 3+ identical calls', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't2', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't3', name: 'get_weather', arguments: { location: 'NYC' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(!result.ok);
    assert.ok(result.errors[0].includes('Parallel loop'));
  });

  it('should pass with 2 identical calls (not enough for loop detection)', () => {
    const tcs: ParsedToolCall[] = [
      { id: 't1', name: 'get_weather', arguments: { location: 'NYC' } },
      { id: 't2', name: 'get_weather', arguments: { location: 'NYC' } },
    ];
    const result = detectParallelToolLoop(tcs);
    assert.ok(result.ok);
  });
});
