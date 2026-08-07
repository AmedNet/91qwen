import { describe, expect, test } from 'bun:test';
import { toolEnvelopeClose, toolEnvelopeOpen } from './nonceToolParser.ts';
import { consumeNonceToolChunk, createNonceToolStreamState, flushNonceToolStream } from './nonceToolStream.ts';
import { normalizeAnswerChunk } from '../routes/chatHelpersCore.ts';

const nonce = '0123456789abcdef';
const tools = [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];

describe('envelope followed by cumulative snapshot (regression)', () => {
  test('cumulative re-send of the whole envelope after it was already streamed', () => {
    const envelope = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)}`;
    const state = createNonceToolStreamState();
    let previous = '';
    let mode: any = 'unknown';
    let content = '';
    let error = '';

    // Realistic Qwen pattern: incremental chunks stream the envelope, then a
    // final cumulative snapshot repeats the whole thing.
    const snapshots = [envelope.slice(0, 40), envelope.slice(40, 80), envelope];
    for (const snapshot of snapshots) {
      const normalized = normalizeAnswerChunk(snapshot, previous, mode);
      previous = normalized.previousChunk;
      mode = normalized.mode;
      const result = consumeNonceToolChunk(state, normalized.delta, nonce, tools);
      content += result.content;
      error = result.error || error;
    }

    const flushed = flushNonceToolStream(state);
    expect(error).toBeUndefined();
    expect(flushed.error).toBeUndefined();
    expect(flushed.toolCalls).toHaveLength(1);
    expect(flushed.toolCalls[0]?.name).toBe('Bash');
  });

  test('cumulative snapshot that repeats the envelope prefix from a short first chunk', () => {
    const envelope = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)}`;
    const state = createNonceToolStreamState();
    let previous = '';
    let mode: any = 'unknown';
    let content = '';
    let error = '';

    // First snapshot is a tiny prefix (below the 8-char cumulative threshold),
    // then a full cumulative snapshot. The opener bytes get withheld, then the
    // snapshot re-sends them — must not be treated as trailing content after
    // completion.
    const snapshots = [envelope.slice(0, 6), envelope];
    for (const snapshot of snapshots) {
      const normalized = normalizeAnswerChunk(snapshot, previous, mode);
      previous = normalized.previousChunk;
      mode = normalized.mode;
      const result = consumeNonceToolChunk(state, normalized.delta, nonce, tools);
      content += result.content;
      error = result.error || error;
    }

    const flushed = flushNonceToolStream(state);
    expect(error).toBeUndefined();
    expect(flushed.error).toBeUndefined();
    expect(flushed.toolCalls).toHaveLength(1);
    expect(flushed.toolCalls[0]?.name).toBe('Bash');
  });

  test('legit text after a completed envelope is still rejected', () => {
    const state = createNonceToolStreamState();
    const raw = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"pwd"}}]}${toolEnvelopeClose(nonce)} extra text`;
    const result = consumeNonceToolChunk(state, raw, nonce, tools);
    expect(result.error).toContain('final output');
  });
});
