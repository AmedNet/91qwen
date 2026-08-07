import { describe, expect, test } from 'bun:test';
import { normalizeAnswerChunk } from '../routes/chatHelpersCore.ts';
import { toolEnvelopeClose, toolEnvelopeOpen } from './nonceToolParser.ts';
import { consumeNonceToolChunk, createNonceToolStreamState, flushNonceToolStream } from './nonceToolStream.ts';

const nonce = '0123456789abcdef';
const tools = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];

describe('nonceToolStream', () => {
  test('normalizes cumulative snapshots without dropping repeated incremental characters', () => {
    let previous = '';
    let mode: any = 'unknown';
    let output = '';
    for (const chunk of ['<', '<', '<', 'Q']) {
      const result = normalizeAnswerChunk(chunk, previous, mode);
      previous = result.previousChunk;
      mode = result.mode;
      output += result.delta;
    }
    expect(output).toBe('<<<Q');

    previous = '';
    mode = 'unknown';
    output = '';
    for (const snapshot of ['abcdefgh', 'abcdefgh123', 'abcdefgh123456']) {
      const result = normalizeAnswerChunk(snapshot, previous, mode);
      previous = result.previousChunk;
      mode = result.mode;
      output += result.delta;
    }
    expect(output).toBe('abcdefgh123456');
  });

  test('does not leak marker bytes when a short first snapshot hides cumulative mode', () => {
    const envelope = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)}`;
    const state = createNonceToolStreamState();
    let previous = '';
    let mode: any = 'unknown';
    let content = '';
    // The first snapshot is shorter than the cumulative-detection threshold, so
    // the next snapshot is treated as incremental and re-sends withheld bytes.
    for (const snapshot of ['<<<QG', envelope]) {
      const normalized = normalizeAnswerChunk(snapshot, previous, mode);
      previous = normalized.previousChunk;
      mode = normalized.mode;
      content += consumeNonceToolChunk(state, normalized.delta, nonce, tools).content;
    }
    const flushed = flushNonceToolStream(state);
    content += flushed.content;

    expect(content).toBe('');
    expect(flushed.error).toBeUndefined();
    expect(flushed.toolCalls).toHaveLength(1);
    expect(flushed.toolCalls[0]?.name).toBe('Bash');
  });

  test('preserves normal text exactly across arbitrary less-than signs', () => {
    const state = createNonceToolStreamState();
    const chunks = ['const x = a <', ' b;\n<div>', 'ok</div>'];
    let content = '';
    for (const chunk of chunks) content += consumeNonceToolChunk(state, chunk, nonce, tools).content;
    content += flushNonceToolStream(state).content;
    expect(content).toBe(chunks.join(''));
  });

  test('recognizes a marker split one character per chunk', () => {
    const state = createNonceToolStreamState();
    const raw = `Before ${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)}`;
    let content = '';
    let calls: any[] = [];
    for (const char of raw) {
      const result = consumeNonceToolChunk(state, char, nonce, tools);
      content += result.content;
      calls = calls.concat(result.toolCalls);
      expect(result.error).toBeUndefined();
    }
    expect(content).toBe('Before ');
    expect(calls).toHaveLength(0);
    calls = calls.concat(flushNonceToolStream(state).toolCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ command: 'pwd' });
  });

  test('rejects malformed JSON without releasing envelope bytes', () => {
    const state = createNonceToolStreamState();
    const raw = `${toolEnvelopeOpen(nonce)}{bad json}${toolEnvelopeClose(nonce)}`;
    const result = consumeNonceToolChunk(state, raw, nonce, tools);
    expect(result.content).toBe('');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.error).toContain('invalid JSON');
  });

  test('rejects an incomplete opened envelope on flush', () => {
    const state = createNonceToolStreamState();
    consumeNonceToolChunk(state, `${toolEnvelopeOpen(nonce)}{"tool_calls":[`, nonce, tools);
    const result = flushNonceToolStream(state);
    expect(result.error).toContain('closing marker');
    expect(result.content).toBe('');
  });

  test('rejects a marker with the wrong nonce across arbitrary chunks', () => {
    const state = createNonceToolStreamState();
    let content = '';
    let error = '';
    for (const char of '<<<QG_TOOL_deadbeef>>>{}') {
      const result = consumeNonceToolChunk(state, char, nonce, tools);
      content += result.content;
      error = result.error || error;
    }
    expect(error).toContain('does not match');
    expect(content).toBe('');
  });

  test('rejects non-whitespace after a completed envelope', () => {
    const state = createNonceToolStreamState();
    const raw = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)} leaked`;
    const result = consumeNonceToolChunk(state, raw, nonce, tools);
    expect(result.error).toContain('final output');
    expect(result.toolCalls).toHaveLength(0);
  });
});
