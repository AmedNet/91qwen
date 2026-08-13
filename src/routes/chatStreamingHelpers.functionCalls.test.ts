import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('streaming function_calls envelope is parsed and not leaked as content', async () => {
  const logId = 'test-function-calls-envelope';
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
    completionId: 'test-function-calls',
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
    '<function_calls',
    '>\n<invoke',
    ' name="execute_command',
    '">\n<',
    'parameter name="command',
    '">cd "J',
    ':\\Program Files (',
    'x86)\\',
    'qwen-gate',
    '" && git status',
    '\n',
    '\n',
    '</function_calls>',
    '后续内容',
  ];

  for (const text of chunks) {
    await processStreamData(
      { choices: [{ delta: { phase: 'answer', content: text } }], response_id: 'r1' },
      state,
      ctx,
    );
  }

  const logEntry = (logStore as any).entryMap.get(logId);
  assert.strictEqual(logEntry.parsedToolCalls.length, 1);
  assert.strictEqual(logEntry.parsedToolCalls[0].name, 'execute_command');

  const assistantContent = writtenEvents
    .map((e) => {
      const m = e.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return m ? JSON.parse(`"${m[1]}"`) : '';
    })
    .join('');

  assert.ok(!assistantContent.includes('git status'), 'command must not leak');
  assert.ok(!assistantContent.includes('function_calls'), 'envelope tag must not leak');
  assert.ok(!assistantContent.includes('invoke'), 'invoke tag must not leak');
  assert.ok(assistantContent.includes('后续内容'), 'prose after the envelope must survive');
});
