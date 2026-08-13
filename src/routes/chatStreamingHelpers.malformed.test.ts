import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('malformed parameter-only tool blocks and tool result echoes do not leak to content', async () => {
  const logId = 'test-malformed-param-and-result-echo';
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
    completionId: 'test-malformed-param',
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
    '拿到文件列表了',
    '，现在',
    '看具体改动内容',
    '。\n\n\n',
    '<function=shell',
    '_command>\n<',
    'parameter=command>',
    'git diff --cached',
    '</',
    'parameter>\n<',
    'parameter=workdir',
    '>J:\\Program Files',
    ' (x86',
    ')\\qwen-g',
    'ate</parameter>',
    '\n<parameter=',
    'timeout_ms',
    '>300',
    '00',
    '</parameter>\n',
    '</function>\n',
    '<parameter=shell',
    '_command>\n<',
    'parameter=command>',
    'git diff</parameter',
    '>\n<',
    'parameter=workdir',
    '>J:\\Program Files',
    ' (x86',
    ')\\qwen-g',
    'ate</parameter>',
    '\n<parameter=',
    'timeout_ms>3',
    '0000',
    '</parameter>\n',
    '</function>\n',
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
  assert.ok(!assistantContent.includes('git diff'), 'parameter values must not leak');
  assert.ok(!assistantContent.includes('Program Files'), 'workdir values must not leak');
  assert.ok(!assistantContent.includes('30000'), 'timeout values must not leak');
  assert.ok(!assistantContent.includes('<parameter'), 'parameter tags must not leak');
  assert.ok(!assistantContent.includes('</function>'), 'function closers must not leak');
  assert.ok(assistantContent.includes('真实回答'), 'prose after the malformed block must survive');
});
