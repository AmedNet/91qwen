import { afterEach, describe, expect, test } from 'bun:test';
import { logStore } from '../services/logStore.ts';
import { toolEnvelopeClose, toolEnvelopeOpen } from '../tools/nonceToolParser.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';
import { handlePostStreamCompletion } from './streamLoop.ts';

const nonce = '0123456789abcdef';
const tools = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

const logIds: string[] = [];

afterEach(() => {
  for (const id of logIds.splice(0)) logStore.finalizeRequest(id);
});

function makeState(): StreamProcessingState {
  return {
    knownResponseIds: new Set(),
    nextParentId: null,
    completionTokens: 0,
    promptTokens: 0,
    currentThoughtIndex: 0,
    reasoningBuffer: '',
    lastFullContent: '',
    lastRawContent: '',
    lastVStrRaw: '',
  };
}

function makeContext(writes: string[], logId: string): StreamProcessingCtx {
  logIds.push(logId);
  logStore.createEntry(logId, 'qwen3.7-max', true);
  return {
    streamWriter: { write: async (value: string) => writes.push(value) },
    completionId: 'chatcmpl-test',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: true,
    cleanOutput: true,
    logId,
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
    toolNonce: nonce,
    clientTools: tools,
  };
}

function answer(content: string, status?: string) {
  return { choices: [{ delta: { phase: 'answer', content, status } }] };
}

describe('streaming nonce tool protocol', () => {
  test('preserves code containing legacy XML syntax as ordinary content', async () => {
    const writes: string[] = [];
    const state = makeState();
    const ctx = makeContext(writes, 'nonce-stream-code');
    const text = 'Review regex: /^<function=([^\\s>]+)/ and <div>ok</div>.';

    expect(await processStreamData(answer(text), state, ctx)).toBe('continue');

    expect(state.lastFullContent).toBe(text);
    expect(ctx.emittedToolCallCount).toBe(0);
    expect(writes.join('')).toContain(JSON.stringify(text).slice(1, -1));
    expect(writes.join('')).not.toContain('tool_calls');
  });

  test('withholds envelope bytes and commits only a structured call at flush', async () => {
    const writes: string[] = [];
    const state = makeState();
    const ctx = makeContext(writes, 'nonce-stream-tool');
    const envelope = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":"git status"}}]}${toolEnvelopeClose(nonce)}`;

    for (const char of envelope) {
      expect(await processStreamData(answer(char), state, ctx)).toBe('continue');
    }
    expect(writes.join('')).not.toContain('tool_calls');
    expect(writes.join('')).not.toContain('git status');

    await handlePostStreamCompletion(
      {
        streamWriter: ctx.streamWriter,
        completionId: ctx.completionId,
        model: ctx.model,
        streamState: state,
        ampState: ctx.ampState,
        logId: ctx.logId,
        resolvedEmail: ctx.resolvedEmail,
        emittedToolCallCount: ctx.emittedToolCallCount,
        buffer: '',
        enableContentFiltering: true,
        includeUsage: false,
        tools,
        toolNonce: nonce,
      },
      {
        reader: { cancel: async () => {}, releaseLock: () => {} } as any,
        heartbeatInterval: undefined,
        chatId: 'chat-test',
        sessionHeaders: {},
        email: 'test@example.com',
        sessionPool: { release: () => {} },
      },
    );

    const output = writes.join('');
    expect(output).toContain('"tool_calls"');
    expect(output).toContain('"name":"Bash"');
    expect(output).toContain('\\"command\\":\\"git status\\"');
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).not.toContain(toolEnvelopeOpen(nonce));
    expect(output).not.toContain(toolEnvelopeClose(nonce));
  });

  test('records a protocol error without emitting malformed arguments', async () => {
    const writes: string[] = [];
    const state = makeState();
    const ctx = makeContext(writes, 'nonce-stream-invalid');
    const envelope = `${toolEnvelopeOpen(nonce)}{"tool_calls":[{"name":"Bash","arguments":{"command":""}}]}${toolEnvelopeClose(nonce)}`;

    expect(await processStreamData(answer(envelope), state, ctx)).toBe('break_stream');
    expect(state.toolProtocolError).toContain('command');
    expect(writes.join('')).not.toContain('tool_calls');
    expect(writes.join('')).not.toContain(toolEnvelopeOpen(nonce));
  });
});
