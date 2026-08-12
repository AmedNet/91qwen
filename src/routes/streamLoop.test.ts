import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { runStreamLoop } from './streamLoop.ts';

describe('runStreamLoop - non-SSE JSON error envelope', () => {
  const errors: string[] = [];
  const events: string[] = [];
  const writes: string[] = [];

  beforeEach(() => {
    errors.length = 0;
    events.length = 0;
    writes.length = 0;
  });

  it('surfaces Qwen non-SSE JSON error envelope as SSE error to the client', async () => {
    const errBody = JSON.stringify({
      success: false,
      data: { code: 'CHAT_IN_PROGRESS', details: 'The chat is in progress!' },
    });

    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        // Qwen upstream returns the JSON error as the entire response body
        // wrapped in an SSE-shaped envelope. Each line is NOT prefixed with `data: `.
        controller.enqueue(new TextEncoder().encode(errBody + '\n'));
        controller.close();
      },
    }).getReader();

    const writer = {
      write: async (s: string) => {
        writes.push(s);
        events.push(s);
      },
    };

    const streamState: any = {
      targetResponseId: null,
      nextParentId: null,
      currentThoughtIndex: 0,
      reasoningBuffer: '',
      lastFullContent: '',
      lastRawContent: '',
      lastFilteredSnapshot: '',
      lastThinkingSnapshot: '',
      lastVStrRaw: '',
      lastFilteredFullContent: '',
      lastDeltaThinkingFull: '',
      loggedToolCalls: new Set(),
      lastParsePosition: 0,
      toolCallDepth: 0,
      openFnTagCount: 0,
      closeFnTagCount: 0,
      openLlmMetaCount: 0,
      closeLlmMetaCount: 0,
      llmMetaDepth: 0,
      pendingChunk: '',
    };

    const streamCtx: any = {
      streamWriter: writer,
      completionId: 'cmpl-test',
      model: 'qwen3.8-max',
      emittedToolCallCount: 0,
      enableContentFiltering: false,
      cleanOutput: false,
      logId: 'test-log-id',
      resolvedEmail: 'test@test.com',
      ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
      qwenAbortController: new AbortController(),
      sseEventCount: 0,
    };

    // Mock logStore to avoid DB / FS side effects
    const { logStore } = await import('../services/logStore.ts');
    const addErrorSpy = spyOn(logStore, 'addError').mockImplementation(() => {});
    const updateEntrySpy = spyOn(logStore, 'updateEntry').mockImplementation(() => {});

    const result = await runStreamLoop(
      { req: { raw: { signal: undefined } } },
      reader,
      streamState,
      streamCtx,
      streamCtx.ampState,
      { text: '' },
    );

    // Verify the error message was surfaced to the client
    const allOutput = writes.join('');
    expect(allOutput).toContain('CHAT_IN_PROGRESS');
    expect(allOutput).toContain('The chat is in progress');
    expect(allOutput).toContain('data: [DONE]');
  });

  it('continues to parse normal SSE data: frames', async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';

    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    }).getReader();

    const writer = {
      write: async (s: string) => {
        writes.push(s);
      },
    };

    const streamState: any = {
      targetResponseId: null,
      nextParentId: null,
      currentThoughtIndex: 0,
      reasoningBuffer: '',
      lastFullContent: '',
      lastRawContent: '',
      lastFilteredSnapshot: '',
      lastThinkingSnapshot: '',
      lastVStrRaw: '',
      lastFilteredFullContent: '',
      lastDeltaThinkingFull: '',
      loggedToolCalls: new Set(),
      lastParsePosition: 0,
      toolCallDepth: 0,
      openFnTagCount: 0,
      closeFnTagCount: 0,
      openLlmMetaCount: 0,
      closeLlmMetaCount: 0,
      llmMetaDepth: 0,
      pendingChunk: '',
    };

    const streamCtx: any = {
      streamWriter: writer,
      completionId: 'cmpl-test2',
      model: 'qwen3.7-max',
      emittedToolCallCount: 0,
      enableContentFiltering: false,
      cleanOutput: false,
      logId: 'test-log-id-2',
      resolvedEmail: 'test@test.com',
      ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
      qwenAbortController: new AbortController(),
      sseEventCount: 0,
    };

    const { logStore } = await import('../services/logStore.ts');
    const addErrorSpy = spyOn(logStore, 'addError').mockImplementation(() => {});

    await runStreamLoop(
      { req: { raw: { signal: undefined } } },
      reader,
      streamState,
      streamCtx,
      streamCtx.ampState,
      { text: '' },
    );

    const allOutput = writes.join('');
    expect(allOutput).toContain('Hello');
    expect(allOutput).toContain('world');
    // No error was raised
    expect(addErrorSpy).not.toHaveBeenCalled();

    addErrorSpy.mockRestore();
  });
});
