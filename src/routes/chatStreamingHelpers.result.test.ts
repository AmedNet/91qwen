import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('tagless tool result echo does not leak stdout content', async () => {
  const logId = 'test-tagless-result-echo';
  logStore.createEntry(logId, 'qwen3.8-max', true);

  const state: StreamProcessingState = {
    targetResponseId: null,
    nextParentId: null,
    completionTokens: 0,
    promptTokens: 0,
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

  const writtenEvents: string[] = [];
  const ctx: StreamProcessingCtx = {
    streamWriter: { write: async (chunk: string) => void writtenEvents.push(chunk) },
    completionId: 'test-tagless-result',
    model: 'qwen3.8-max',
    emittedToolCallCount: 0,
    enableContentFiltering: true,
    cleanOutput: true,
    logId,
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
  };

  const chunks = [
    '我先执行命令。',
    'tool_result tool',
    '_name="shell_command" success="true">',
    '<command>shell_command</command>',
    '<stdout>Exit code: 0',
    'secret output',
    '</stdout>',
    '</tool_result>',
    '真实回答',
  ];

  for (const text of chunks) {
    await processStreamData(
      { choices: [{ delta: { phase: 'answer', content: text } }], response_id: 'r1' },
      state,
      ctx,
    );
  }

  const assistantContent = writtenEvents
    .map((e) => {
      const m = e.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return m ? JSON.parse(`"${m[1]}"`) : '';
    })
    .join('');

  assert.ok(!assistantContent.includes('shell_command'), 'tool name must not leak');
  assert.ok(!assistantContent.includes('secret output'), 'stdout must not leak');
  assert.ok(!assistantContent.includes('<stdout'), 'stdout tag must not leak');
  assert.ok(!assistantContent.includes('<command'), 'command tag must not leak');
  assert.ok(assistantContent.includes('我先执行命令。'), 'prose before echo must survive');
  assert.ok(assistantContent.includes('真实回答'), 'prose after echo must survive');
});
