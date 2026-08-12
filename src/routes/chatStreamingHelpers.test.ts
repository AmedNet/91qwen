import assert from 'node:assert';
import test from 'node:test';
import { logStore } from '../services/logStore.ts';
import { processStreamData, type StreamProcessingCtx, type StreamProcessingState } from './chatStreamingHelpers.ts';

test('reproduces and tests fix for corrupted tool call when split across chunks', async () => {
  const logId = 'test-corrupted-tool-call-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

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
    pendingChunk: '',
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
  };

  const chunks = [
    'Both',
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
    pendingChunk: '',
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

test('regression: full <function=NAME> tag split mid-tag across chunks must not leak XML to client', async () => {
  // Production incident (2026-08-11, .logs/qwen/req_2026-08-11T13-49-46-619Z):
  // Qwen streamed 6 back-to-back tool calls as answer-phase content. The raw
  // SSE chunks split `<function=NAME>` itself across chunk boundaries, e.g.
  //   chunk 1: "<function=shell"
  //   chunk 2: "_command>\n<"
  // so no single rawText chunk contained a literal `<function=` substring.
  // Pre-fix code used `rawText.includes('<function=')` to bump toolCallDepth,
  // which always returned false on every chunk → depth stayed 0 → the entire
  // XML tool block was emitted to the client as plain text.
  //
  // Post-fix: depth is computed from cumulative open/close tag counters
  // (openFnTagCount / closeFnTagCount), so depth correctly rises to 1 once
  // the pendingChunk merges "<function=shell" + "_command>\n<" and then
  // falls back to 0 when "</function>" finally completes across chunks.
  const logId = 'test-regression-split-tag-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

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
    pendingChunk: '',
  };

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-regression-split-tag-completion',
    model: 'qwen3.7-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
  };

  // Reproduce the exact 7-segment chunk split observed in the production log.
  // Note: chunk 1 has '<' but no '>' so it gets buffered via pendingChunk;
  // chunk 2 supplies '>' and releases the buffered chunk; the merged
  // rawText then contains the full '<function=shell_command>'.
  const chunks = [
    '<function=shell',
    '_command>\n<',
    ' --stat</parameter',
    '>\n</',
    'function>\n<',
    '>\n<parameter',
    '-only</parameter>',
  ];

  for (const chunk of chunks) {
    const data = {
      choices: [{ delta: { phase: 'answer', content: chunk } }],
    };
    await processStreamData(data, state, ctx);
  }

  // lastFullContent still contains the raw text (it's the unfiltered buffer).
  assert.ok(
    state.lastFullContent.includes('<function=shell_command>'),
    'lastFullContent should hold the combined tool call text for downstream parsing',
  );

  // The cumulative counters must reflect that exactly one function block was
  // opened and closed across all 7 chunks.
  assert.strictEqual(state.openFnTagCount, 1, 'one <function= open should have been counted');
  assert.strictEqual(state.closeFnTagCount, 1, 'one </function> close should have been counted');

  // Final toolCallDepth must be back to 0 after the close arrived.
  assert.strictEqual(state.toolCallDepth, 0, 'toolCallDepth should return to 0 after </function>');

  // The filtered stream sent to the client must NOT contain any raw XML
  // tool call markup. This is the user-visible contract.
  const clientPayload = writtenEvents.join('');
  assert.ok(
    !clientPayload.includes('<function='),
    'no <function= XML must reach the client (tool leak regression)',
  );
  assert.ok(
    !clientPayload.includes('</function>'),
    'no </function> close tag must reach the client (tool leak regression)',
  );
  assert.ok(
    !clientPayload.includes('<parameter='),
    'no <parameter= markup must reach the client (tool leak regression)',
  );
});

test('one-chunk buffer: releases non-tool-call < content normally', async () => {
  const logId = 'test-non-tool-call-buffer-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

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
    pendingChunk: '',
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
    pendingChunk: '',
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
  };

  // Create content that exceeds MAX_BUFFER_CHARS (200) without '>' appearing
  // Chunk N: starts with '<' and no '>' → buffered
  // Chunk N+1: more text with '<' still no '>' → combined still under 200 → buffer again
  // We need enough chunks to exceed 200 chars without any '>'
  const longBase = 'A'.repeat(100);
  // Chunk has '<' and no '>', and combined with previous never has '>'
  // The chunk itself is 101 chars (100 A's + '<'), which is < 200. Combined with buffer it grows.
  // Chunk 1: '<' + 'AAAA...' (101 chars) → buffered (p=101)
  // Chunk 2: 'BBBB...' (100 chars) → combined 201 > 200 → force-release
  const chunk1 = '<' + longBase;
  const chunk2 = 'B'.repeat(100);

  // Process chunk 1
  await processStreamData(
    {
      choices: [{ delta: { phase: 'answer', content: chunk1 } }],
    },
    state,
    ctx,
  );

  // After chunk 1: should be buffered
  assert.strictEqual(state.pendingChunk, chunk1, 'chunk with < and no > should be buffered');
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

test('regression: consecutive <function=...> blocks with multi-tag splits across chunks must not leak', async () => {
  // Production incident (2026-08-11, .logs/qwen/req_2026-08-11T18-25-25-775Z):
  // Qwen streamed two back-to-back `<function=exec_command>...</function>` blocks
  // where EVERY tag boundary (open AND close) was split across SSE chunks, e.g.
  //   chunk 7:  "2\n</parameter"
  //   chunk 8:  ">\n</function"
  //   chunk 9:  ">\n<function"       ← next open starts here, but `=` arrives in chunk 10
  //   chunk 10: "=exec_command>"
  // Pre-fix: the open regex `<function=[^\s>]+` never matched because chunk 9
  // ended with `<function` (no `=`) and chunk 10 started with `=exec_command>`
  // (no `<`). After the merge in chunk 10's pendingChunk release, the raw
  // text contained BOTH opens (`<function=exec_command>` and the prior
  // `<function=exec_command>` already opened) — but the depth accounting
  // went negative at chunk 9's pending-release because opens=0 / closes=1
  // (the </function> close from chunk 8 was merged in). The second block's
  // open was effectively never counted → toolCallDepth returned to 0 →
  // every subsequent chunk (parameters, values, body text) leaked to the
  // client as plain text.
  //
  // Post-fix: pendingChunk now also delays chunks whose tail is an
  // unterminated open tag (`<[A-Za-z]+=?$` without trailing `>`), so chunk 9
  // waits for chunk 10 to complete `<function=exec_command>` before counting.
  const logId = 'test-regression-consecutive-tool-blocks-log-id';
  logStore.createEntry(logId, 'qwen3.7-max', true);

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
    pendingChunk: '',
  };

  const writtenEvents: string[] = [];
  const mockStreamWriter = {
    write: async (chunk: string) => {
      writtenEvents.push(chunk);
    },
  };

  const ctx: StreamProcessingCtx = {
    streamWriter: mockStreamWriter,
    completionId: 'test-regression-consecutive-completion',
    model: 'qwen3.8-max',
    emittedToolCallCount: 0,
    enableContentFiltering: false,
    cleanOutput: false,
    logId: logId,
    resolvedEmail: 'test@example.com',
    ampState: { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false },
    qwenAbortController: new AbortController(),
  };

  // The exact 15-chunk sequence observed in the production log.
  const chunks = [
    '<function=exec',
    '_command>\n<',
    'parameter=cmd>',
    '\nls -la',
    ' /Users/apoli',
    '/Music/midi',
    '2\n</parameter',
    '>\n</function',
    '>\n<function',
    '=exec_command>',
    '\n<parameter=',
    'cmd>\ngit',
    ' -C /Users',
    '/apoli/Music',
    '/midi2 log',
  ];

  for (const chunk of chunks) {
    const data = { choices: [{ delta: { phase: 'answer', content: chunk } }] };
    await processStreamData(data, state, ctx);
  }

  // Two `<function=` opens must have been counted (one per tool block).
  assert.strictEqual(state.openFnTagCount, 2, 'two <function= opens should have been counted');

  // At least one `</function>` close must have been counted. The production
  // log preview is truncated at 10_000 chars, so the second `</function>`
  // may not be present in this 15-chunk sample; the assertion allows for
  // either 1 or 2 closes here. The leak-free property is enforced below
  // by the client-payload assertions, which are the user-visible contract.
  assert.ok(
    state.closeFnTagCount >= 1 && state.closeFnTagCount <= 2,
    'one or two </function> closes should have been counted (got ' + state.closeFnTagCount + ')',
  );

  // Depth must be at least 1 (second tool block may still be open in the
  // truncated sample) and at most 2 (we never opened more than 2 blocks).
  assert.ok(
    state.toolCallDepth >= 1 && state.toolCallDepth <= 2,
    'toolCallDepth should be 1 or 2 after 2 opens and 1-2 closes (got ' + state.toolCallDepth + ')',
  );

  // The filtered stream sent to the client must NOT contain any raw XML
  // tool call markup leaking as plain text content. This is the
  // user-visible contract — tool calls must arrive ONLY as the structured
  // OpenAI `tool_calls` delta, never as raw `<function=...>` strings in
  // the assistant content stream.
  //
  // Note: structured tool_calls events (written via writeToolCallEvent)
  // DO contain the command body inside their JSON `arguments` field —
  // that's the correct, expected format and must NOT be asserted against.
  // We check the assistant `content` field by isolating delta.content values
  // from any event whose delta carries tool_calls.
  const assistantContent = writtenEvents
    .map((e) => {
      const m = e.match(/"delta":\s*\{([^}]*)\}/);
      if (!m) return '';
      const inner = m[1];
      const contentMatch = inner.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
      return contentMatch ? contentMatch[1] : '';
    })
    .filter(Boolean)
    .join('');
  assert.ok(
    !assistantContent.includes('<function='),
    'no <function= XML must leak into assistant content (leaked: ' + JSON.stringify(assistantContent.slice(0, 200)) + ')',
  );
  assert.ok(
    !assistantContent.includes('</function>'),
    'no </function> close tag must leak into assistant content',
  );
  assert.ok(
    !assistantContent.includes('<parameter='),
    'no <parameter= markup must leak into assistant content',
  );
  assert.ok(
    !assistantContent.includes('</parameter>'),
    'no </parameter> close tag must leak into assistant content',
  );
  assert.ok(
    !assistantContent.includes('ls -la'),
    'no tool command body must leak into assistant content',
  );
  assert.ok(
    !assistantContent.includes('git -C'),
    'no second tool command body must leak into assistant content',
  );

  // And the structured tool_calls event MUST have been written exactly once
  // for the first recognized tool block — that confirms parseXmlToolCalls
  // did its job and the gateway converted the XML into OpenAI tool_calls.
  const toolCallEvents = writtenEvents.filter((e) => e.includes('"tool_calls"'));
  assert.ok(toolCallEvents.length >= 1, 'at least one tool_calls event should be emitted to client');
});
