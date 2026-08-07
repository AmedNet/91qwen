import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('legacy XML text is preserved and never executed', async () => {
  const logId = 'test-corrupted-tool-call-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: StreamProcessingState = {
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

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-completion-id',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: true,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: {
      rawInputBytes: 0,
      emittedOutputBytes: 0,
      triggered: false,
    },
    qwenAbortController: new AbortController(),
    disableAccount: () => {},
    retryWithNewAccount: () => {},
  };

  const chunks = [
    ' files now set `',
    'thinking_format: "',
    'full"`.\n\n',
    'Now let me also',
    ' add the thinking_format',
    ' to the log',
    ' files as you asked',
    ' earlier, and restart',
    ' the gateway.\n',
    '<function=★',
    '-edit',
    '>\n<parameter',
    '=filePath>\n',
    '/home/youssefv',
    'del/Projects/q',
    'wen-gate/src',
    '/services/logStore.ts',
    '\n</parameter>',
    '\n<parameter=',
    'oldString>\n',
    '  thinkingContent?:',
    ' string;\n ',
    ' amplificationTriggered',
    'Input?: string |',
    ' null;\n</',
    'parameter>\n',
    '<parameter=newString>',
    '\n  thinkingContent',
    '?: string;\n',
    '  thinkingFormat?:',
    ' string;\n ',
    ' amplificationTriggered',
    'Input?: string |',
    ' null;\n</',
    'parameter>\n</',
    'function>\n',
  ];

  for (const chunk of chunks) {
    const data = {
      choices: [
        {
          delta: {
            phase: 'answer',
            content: chunk,
          },
        },
      ],
    };
    await processStreamData(data, state, ctx);
  }

  const logEntry = (logStore as any).entryMap.get(logId);
  assert.ok(logEntry, 'log entry should exist');
  assert.strictEqual(logEntry.parsedToolCalls.length, 0, 'legacy XML must not create executable tool calls');
  assert.strictEqual(writtenEvents.filter((e) => e.includes('tool_calls')).length, 0);

  const reconstructedContent = writtenEvents
    .filter((e) => e.includes('"content"'))
    .map((event) => {
      const match = event.match(/^data: (\{.*\})\n\n$/);
      return match ? JSON.parse(match[1]).choices[0].delta.content || '' : '';
    })
    .join('');
  assert.strictEqual(reconstructedContent, chunks.join(''), 'legacy XML/code text must be preserved exactly');
});

test('ordinary less-than content streams immediately without XML buffering', async () => {
  const logId = 'test-one-chunk-buffer-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: StreamProcessingState = {
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

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-completion-id-2',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: {
      rawInputBytes: 0,
      emittedOutputBytes: 0,
      triggered: false,
    },
    qwenAbortController: new AbortController(),
    disableAccount: () => {},
    retryWithNewAccount: () => {},
  };

  // Legacy XML-looking text is ordinary content without the request nonce.
  const chunks = ['<func', 'tion=read>\nHello world\n'];

  for (const chunk of chunks) {
    const data = {
      choices: [
        {
          delta: {
            phase: 'answer',
            content: chunk,
          },
        },
      ],
    };
    await processStreamData(data, state, ctx);
  }

  assert.strictEqual(state.lastFullContent, chunks.join(''));
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.strictEqual(contentEvents.length, 2, 'both ordinary text chunks should stream immediately');
});

test('ordinary less-than and greater-than content streams normally', async () => {
  const logId = 'test-non-tool-call-buffer-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: StreamProcessingState = {
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

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-completion-id-3',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: {
      rawInputBytes: 0,
      emittedOutputBytes: 0,
      triggered: false,
    },
    qwenAbortController: new AbortController(),
    disableAccount: () => {},
    retryWithNewAccount: () => {},
  };

  // Ordinary comparison text split across chunks must be emitted unchanged.
  const chunks = ['Here x < ', '10 and y > 5.\n'];

  for (const chunk of chunks) {
    const data = {
      choices: [
        {
          delta: {
            phase: 'answer',
            content: chunk,
          },
        },
      ],
    };
    await processStreamData(data, state, ctx);
  }

  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.ok(contentEvents.length > 0, 'content should be emitted for non-tool-call text');

  // Reconstruct emitted content
  let reconstructedContent = '';
  for (const event of contentEvents) {
    const match = event.match(/^data: (\{.*\})\n\n$/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      const content = parsed.choices[0].delta.content;
      if (content) reconstructedContent += content;
    }
  }

  // The original text should be in the emitted content (with < preserved)
  assert.ok(reconstructedContent.includes('<'), 'emitted content should preserve < character');
  assert.ok(reconstructedContent.includes('>'), 'emitted content should preserve > character');
  assert.ok(reconstructedContent.includes('10'), 'emitted content should contain the full text');
});

test('long less-than content streams without a buffer limit', async () => {
  const logId = 'test-buffer-overflow-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

  const state: StreamProcessingState = {
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

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-completion-id-4',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: {
      rawInputBytes: 0,
      emittedOutputBytes: 0,
      triggered: false,
    },
    qwenAbortController: new AbortController(),
    disableAccount: () => {},
    retryWithNewAccount: () => {},
  };

  // Long legacy tag-like text must not wait for an XML buffer threshold.
  const chunk1 = '<funct' + 'A'.repeat(50);
  const chunk2 = 'B'.repeat(160);

  // Process chunk 1
  await processStreamData(
    {
      choices: [{ delta: { phase: 'answer', content: chunk1 } }],
    },
    state,
    ctx,
  );
  await processStreamData(
    {
      choices: [{ delta: { phase: 'answer', content: chunk2 } }],
    },
    state,
    ctx,
  );

  assert.strictEqual(state.lastFullContent, chunk1 + chunk2);
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.strictEqual(contentEvents.length, 2, 'both chunks should stream without waiting for a threshold');
});

function buildTestCtx(overrides: Partial<StreamProcessingCtx> = {}): {
  ctx: StreamProcessingCtx;
  retriedEmails: string[];
} {
  const retriedEmails: string[] = [];
  const ctx: StreamProcessingCtx = {
    streamWriter: { write: async () => {} },
    completionId: 'test-completion-id',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: true,
    logId: 'test-stream-error-log-id',
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
    retryWithNewAccount: (email) => retriedEmails.push(email),
    ...overrides,
  };
  return { ctx, retriedEmails };
}

function buildTestState(): StreamProcessingState {
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

test('data.error non-RateLimited sets ctx.streamError and breaks stream', async () => {
  const { ctx } = buildTestCtx();
  const state = buildTestState();

  const result = await processStreamData(
    { error: { code: 'quota_limit', message: 'The service is currently experiencing high demand' } },
    state,
    ctx,
  );

  assert.strictEqual(result, 'break_stream');
  assert.ok(ctx.streamError, 'streamError should be set for non-RateLimited error');
  assert.strictEqual(ctx.streamError?.upstreamCode, 'quota_limit');
  assert.match(ctx.streamError?.message || '', /high demand/);
});

test('delta.status error non-RateLimited sets ctx.streamError and breaks stream', async () => {
  const { ctx } = buildTestCtx();
  const state = buildTestState();

  const result = await processStreamData(
    { choices: [{ delta: { status: 'error', code: 'boom', message: 'upstream exploded' } }] },
    state,
    ctx,
  );

  assert.strictEqual(result, 'break_stream');
  assert.ok(ctx.streamError, 'streamError should be set for non-RateLimited delta error');
  assert.strictEqual(ctx.streamError?.code, 'boom');
});

test('RateLimited does NOT set streamError and returns retry_account', async () => {
  const { ctx, retriedEmails } = buildTestCtx();
  const state = buildTestState();

  const result = await processStreamData(
    { error: 'RateLimited: daily usage limit reached' },
    state,
    ctx,
  );

  assert.strictEqual(result, 'retry_account');
  assert.ok(ctx.streamError === undefined, 'streamError must NOT be set on RateLimited path');
  assert.deepStrictEqual(retriedEmails, ['test@example.com']);
});
