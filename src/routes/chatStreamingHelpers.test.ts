import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('reproduces and tests fix for corrupted tool call when split across chunks', async () => {
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
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
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

  // 1. Verify that the tool call was successfully parsed and recorded in the logStore entry
  const logEntry = (logStore as any).entryMap.get(logId);
  assert.ok(logEntry, 'log entry should exist');
  assert.strictEqual(logEntry.parsedToolCalls.length, 1, 'should have parsed exactly one tool call');
  assert.strictEqual(logEntry.parsedToolCalls[0].name, '★-edit', 'tool call name should be ★-edit');

  // 2. Verify that the emitted tool call event is sent to the client
  const toolCallEvents = writtenEvents.filter((e) => e.includes('tool_calls'));
  assert.strictEqual(toolCallEvents.length, 1, 'should have emitted exactly one tool call event to client');
  assert.ok(toolCallEvents[0].includes('★-edit') || toolCallEvents[0].includes('edit'), 'emitted tool call should be edit');

  // 3. Verify that the content streamed to the client does NOT contain leaked function tags/parameters
  // Reconstruct emitted content from content events
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  let reconstructedContent = '';
  for (const event of contentEvents) {
    // Extract JSON payload from SSE "data: <json>\n\n"
    const match = event.match(/^data: (\{.*\})\n\n$/);
    if (match) {
      const parsed = JSON.parse(match[1]);
      const content = parsed.choices[0].delta.content;
      if (content) reconstructedContent += content;
    }
  }

  // Ensure that no function/parameter tags or leaked fragments (-edit, filePath, etc.) are present in content
  assert.ok(!reconstructedContent.includes('<function='), 'should not leak function tag');
  assert.ok(!reconstructedContent.includes('edit'), 'should not leak tool name edit in content');
  assert.ok(!reconstructedContent.includes('filePath'), 'should not leak parameter filePath in content');
  assert.ok(!reconstructedContent.includes('oldString'), 'should not leak parameter oldString in content');
  assert.ok(!reconstructedContent.includes('newString'), 'should not leak parameter newString in content');
});

test('one-chunk buffer: delays chunks with < but no > and combines with next chunk', async () => {
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
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
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

  // Simulate a tool call tag split across chunks: <function=read>\n...content...
  // Chunk N: <func (has '<' no '>') → buffered
  // Chunk N+1: tion=read>\nHello world (completes the tag) → combined → tool call detected
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

  // After processing:
  // 1. pendingChunk should be empty (consumed on chunk 2)
  assert.strictEqual(state.pendingChunk, '', 'pendingChunk should be consumed after second chunk');

  // 2. lastFullContent should contain the combined text
  assert.ok(state.lastFullContent.includes('<function=read>'), 'lastFullContent should have combined tool call tag');
  assert.ok(state.lastFullContent.includes('Hello world'), 'lastFullContent should have content text');

  // 3. toolCallDepth should be 1 (inside <function=...>)
  assert.strictEqual(state.toolCallDepth, 1, 'toolCallDepth should be 1 inside open function tag');

  // 4. No content should have been emitted to client (suppressed by toolCallDepth)
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.strictEqual(contentEvents.length, 0, 'no content should be emitted while inside tool call block');
});

test('one-chunk buffer: releases non-tool-call < content normally', async () => {
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
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
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

  // Non-tool-call text with < that might trigger the buffer:
  // Chunk N: "The value is less than <" (has '<' no '>') → buffered
  // Chunk N+1: "10 in this example" → combined → has '<' no '>' still, but < 200 chars → buffer again
  // Chunk N+2: " and it works fine." → combined → still '<' no '>' if no '>' appears
  // Actually, this doesn't have '>'. Let me use a case where '>' appears.
  //
  // Better case: content like "x < 10 and y > 5" split so '<' and '>' are in separate chunks:
  // Chunk N: "Here x < " → has '<' no '>' → buffered
  // Chunk N+1: "10 and y > 5" → combined → has '>' now → NOT buffered → emitted
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

  // After processing:
  // 1. pendingChunk should be empty
  assert.strictEqual(state.pendingChunk, '', 'pendingChunk should be empty after content released');

  // 2. Content should have been emitted to client
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

test('one-chunk buffer: force-releases when MAX_BUFFER_CHARS exceeded', async () => {
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
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
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

  // Force-release scenario: a tag-like chunk grows beyond MAX_BUFFER_CHARS.
  // Use <funct (prefix of "function") so the pre-check allows buffering,
  // then append long content to exceed 200 chars. The content has no '>'
  // so the tag never completes, but length exceeds MAX_BUFFER_CHARS.
  const chunk1 = '<funct' + 'A'.repeat(50);  // ~56 chars, has <funct prefix (looks like function tag)
  const chunk2 = 'B'.repeat(160);  // combined > 200 → force-release

  // Process chunk 1
  await processStreamData(
    {
      choices: [{ delta: { phase: 'answer', content: chunk1 } }],
    },
    state,
    ctx,
  );

  // After chunk 1: should be buffered (looks like function tag start)
  assert.strictEqual(state.pendingChunk, chunk1, 'chunk with tag-like < and no > should be buffered');
  assert.strictEqual(state.lastFullContent, '', 'lastFullContent should NOT accumulate buffered chunk');

  // Process chunk 2: combined length exceeds MAX_BUFFER_CHARS → force-release
  await processStreamData(
    {
      choices: [{ delta: { phase: 'answer', content: chunk2 } }],
    },
    state,
    ctx,
  );

  // After chunk 2: should be force-released
  assert.strictEqual(state.pendingChunk, '', 'pendingChunk should be released after overflow');
  assert.ok(state.lastFullContent.includes(chunk1), 'lastFullContent should contain buffered chunk1 after release');
  assert.ok(state.lastFullContent.includes(chunk2), 'lastFullContent should contain chunk2 after release');

  // Content should have been emitted (it exceeded the buffer limit, force-released as non-tool-call)
  const contentEvents = writtenEvents.filter((e) => !e.includes('tool_calls') && e.includes('"content"'));
  assert.ok(contentEvents.length > 0, 'content should be emitted after buffer overflow force-release');
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
    lastFilteredSnapshot: '',
    lastThinkingSnapshot: '',
    lastVStrRaw: '',
    lastFilteredFullContent: '',
    lastDeltaThinkingFull: '',
    loggedToolCalls: new Set(),
    lastParsePosition: 0,
    toolCallDepth: 0,
    chunksSinceLastTagOpen: 0,
    pendingChunk: '',
    recentChunks: [],
    loopStreak: 0,
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
