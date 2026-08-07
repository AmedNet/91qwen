import assert from 'node:assert';
import test from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
// Set a test API key (never empty 鈥?prevents auth bypass in tests)
process.env.API_KEY = 'test-key-for-testing';

import { app } from '../index.tsx';
import { accounts } from '../services/accountManager.ts';

const TEST_API_KEY = 'test-key-for-testing';
const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

// Shared mock for the Qwen file-upload chain (getstsToken/OSS/parse). The
// gateway always uploads a context.txt on chat requests, so tests that mock
// globalThis.fetch must answer these endpoints or upload fails and — since
// the upload path now retries on the next account instead of inlining — the
// request errors out before the chat/completions handler is reached.
function mockUploadEndpoints(url: string): Response | null {
  if (url.includes('/api/v2/files/getstsToken')) {
    return new Response(
      JSON.stringify({
        data: {
          access_key_id: 'test-key',
          access_key_secret: 'test-secret',
          security_token: 'test-token',
          bucketname: 'test-bucket',
          region: 'oss-cn-hangzhou',
          endpoint: 'oss-cn-hangzhou.aliyuncs.com',
          file_id: 'test-file-id',
          file_path: 'test-user/test-file-id_image.png',
          file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_image.png',
        },
      }),
      { status: 200 },
    );
  }
  if (url.includes('/api/v2/files/parse/status')) {
    return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
  }
  if (url.includes('/api/v2/files/parse')) {
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  if (url.includes('aliyuncs.com') || url.includes('oss-')) {
    return new Response(null, { status: 200 });
  }
  return null;
}

test('Health check returns degraded when Playwright not initialized', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.status, 'degraded');
  assert.ok(typeof body.uptime === 'number');
});

test('Models endpoint returns cleaned OpenAI-compatible model data', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'qwen3.6-plus',
              owned_by: 'qwen',
              info: {
                created_at: 1732711466,
                meta: {
                  max_context_length: 1000000,
                  max_summary_generation_length: 65536,
                  modality: ['text', 'image'],
                  short_description: 'A test model',
                  capabilities: { vision: true, thinking: true },
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/models', { headers: authHeaders });
    const res = await app.fetch(req);

    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'list');
    assert.ok(Array.isArray(body.data));

    const model = body.data[0];
    assert.strictEqual(model.id, 'qwen3.6-plus');
    assert.strictEqual(model.object, 'model');
    assert.strictEqual(model.created, 1732711466);
    assert.strictEqual(model.owned_by, 'qwen');
    assert.strictEqual(model.context_window, 1000000);
    assert.strictEqual(model.max_output_tokens, 65536);
    assert.deepStrictEqual(model.modalities, ['text', 'image']);
    assert.strictEqual(model.description, 'A test model');
    assert.deepStrictEqual(model.capabilities, { vision: true, thinking: true });
    // should not carry raw Qwen-internal fields
    assert.strictEqual(model.info, undefined);
    assert.strictEqual(model.preset, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with qwen3.6-plus (thinking enabled)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);

              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.content) {
                  hasContent = true;
                }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch {
            // Partial JSON ignored
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns explicit error for non-SSE upstream JSON errors', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'RateLimited',
            details: "You've reached the upper limit for today's usage.",
            num: 3,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 502);

    const body = await res.json();
    assert.match(body.error.message, /All accounts have reached their daily usage limit/);
    assert.strictEqual(body.error.type, 'api_error');
    assert.strictEqual(body.error.code, 'api_error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic messages returns upstream error details from non-streaming OpenAI path', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        JSON.stringify({
          success: false,
          data: {
            code: 'Not_Found',
            details: 'Requested chat was not found.',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' }, authHeaders),
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 404);

    const body = await res.json();
    assert.match(body.error.message, /Requested chat was not found/);
    assert.strictEqual(body.error.upstream_code, 'Not_Found');
    assert.strictEqual(body.error.upstream_status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions returns a JSON chat.completion object for non-streaming requests', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'Hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('API Key protection', async () => {
  const originalApiKey = process.env.API_KEY;
  process.env.API_KEY = 'test-api-key';
  let originalFetch: any;

  try {
    // 1. Test request without API Key
    const req1 = new Request('http://localhost/v1/models');
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 401, 'Should return 401 Unauthorized without API Key');

    // 2. Test request with wrong API Key
    const req2 = new Request('http://localhost/v1/models', {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 401, 'Should return 401 Unauthorized with wrong API Key');

    // 3. Test request with correct API Key
    // Mock fetch for models list
    originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    try {
      const req3 = new Request('http://localhost/v1/models', {
        headers: { Authorization: 'Bearer test-api-key' },
      });
      const res3 = await app.fetch(req3);
      assert.strictEqual(res3.status, 200, 'Should return 200 OK with correct API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    process.env.API_KEY = originalApiKey;
  }
});

test('Chat completions with image uploads attaches files (t2t chat_type, vision class)', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account so pickAccount returns an account for image upload
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  let stsCalled = false;
  let ossCalled = false;
  let chatPayload: any = null;

  (globalThis as any).fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      stsCalled = true;
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_image.png',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_image.png',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      ossCalled = true;
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      // Capture the payload for later assertions
      // init?.body is set when browserlessFetch calls globalThis.fetch(url, { method, headers, body })
      const bodyStr =
        typeof input === 'string' && init?.body ? init.body : typeof input !== 'string' ? await (input as Request).clone().text() : '';
      try {
        chatPayload = JSON.parse(bodyStr);
      } catch {}
      // Return a simple stream
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Image received"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA=' } },
          ],
        },
      ],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer test-key-for-testing' }),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Verify STS token was requested (image upload initiated)
    assert.ok(stsCalled, 'Should have called getstsToken for image upload');

    // Verify OSS upload happened
    assert.ok(ossCalled, 'Should have uploaded image to OSS');

    // Verify the chat payload has the right format
    assert.ok(chatPayload, 'Chat completion should have been called');
    const msg = chatPayload?.messages?.[0];
    assert.ok(msg, 'Should have at least one message');

    // The image_url should be stripped from content text (only text parts remain)
    assert.ok(!msg.content.includes('image_url'), 'Image URL should be stripped from content text');
    assert.ok(msg.content.includes('What is in this image?'), 'Text content should be preserved');

    // Should have files attached
    assert.ok(Array.isArray(msg.files), 'Message should have files array');
    assert.ok(msg.files.length > 0, 'Should have at least one file (image)');

    // Chat type should remain t2t (default) 鈥?Qwen web UI uses t2t even with images
    assert.strictEqual(msg.chat_type, 't2t', 'Chat type should remain t2t for images');
    assert.strictEqual(msg.sub_chat_type, 't2t', 'Sub chat type should remain t2t');
    assert.strictEqual(msg.extra?.meta?.subChatType, 't2t', 'Extra subChatType should remain t2t');

    // Verify file attachment format — context.txt may be uploaded alongside images
    // (systemContent is non-empty due to DEFAULT_SYSTEM_PROMPT injection)
    const file = msg.files.find((f: any) => f.type === 'image') || msg.files[0];
    assert.strictEqual(file.type, 'image', 'File attachment type should be image');
    assert.strictEqual(file.file_class, 'vision', 'File class should be vision');
  } finally {
    globalThis.fetch = originalFetch;
    accounts.splice(0, accounts.length, ...originalAccounts);
  }
});

test('Chat Completions endpoint - Non-streaming (stream: false)', async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.6-plus', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices": [{"delta": {"phase": "thinking_summary", "extra": {"summary_thought": {"content": ["Thinking non-stream..."]}}}}]}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: {"choices": [{"delta": {"phase": "answer", "content": "Hello non-stream"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.6-plus',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type')?.includes('application/json'));

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.model, 'qwen3.6-plus');
    assert.ok(body.choices);
    assert.strictEqual(body.choices.length, 1);

    const choice = body.choices[0];
    assert.strictEqual(choice.message.role, 'assistant');
    assert.strictEqual(choice.message.content, 'Hello non-stream');
    assert.strictEqual(choice.message.reasoning_content, 'Thinking non-stream...');
    assert.strictEqual(choice.finish_reason, 'stop');

    assert.ok(body.usage);
    assert.ok(body.usage.prompt_tokens > 0);
    assert.ok(body.usage.completion_tokens >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI non-streaming nonce envelope commits valid tools and rejects invalid arguments', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'nonce-ns@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    const uploadMock = mockUploadEndpoints(url);
    if (uploadMock) return uploadMock;
    if (url.includes('/api/v2/chat/completions')) {
      const upstreamPayload = JSON.parse(String(init?.body || '{}'));
      const prompt = String(upstreamPayload.messages?.[0]?.content || '');
      const nonce = prompt.match(/<<<QG_TOOL_([0-9a-f]{16})>>>/)?.[1];
      assert.ok(nonce, 'Upstream prompt must contain a request nonce');
      const command = prompt.includes('invalid nonce call') ? '' : 'git status';
      const envelope = `<<<QG_TOOL_${nonce}>>>${JSON.stringify({
        tool_calls: [{ name: 'Bash', arguments: { command } }],
      })}<<<QG_END_${nonce}>>>`;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: envelope, status: 'finished' } }] })}\n\n`,
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  const tools = [
    {
      type: 'function',
      function: {
        name: 'Bash',
        description: 'Run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    },
  ];

  try {
    const request = (content: string) =>
      app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
          body: JSON.stringify({ model: 'qwen3.7-max', messages: [{ role: 'user', content }], tools, stream: false }),
        }),
      );

    const validRes = await request('make a valid nonce call');
    assert.strictEqual(validRes.status, 200);
    const validBody = await validRes.json();
    assert.strictEqual(validBody.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(validBody.choices[0].message.content, null);
    assert.strictEqual(validBody.choices[0].message.tool_calls[0].function.name, 'Bash');
    assert.deepStrictEqual(JSON.parse(validBody.choices[0].message.tool_calls[0].function.arguments), { command: 'git status' });
    assert.doesNotMatch(JSON.stringify(validBody), /<<<QG_(?:TOOL|END)_/);

    const invalidRes = await request('make an invalid nonce call');
    assert.strictEqual(invalidRes.status, 502);
    const invalidText = await invalidRes.text();
    const invalidBody = JSON.parse(invalidText);
    assert.strictEqual(invalidBody.error.code, 'tool_protocol_error');
    assert.match(invalidBody.error.message, /command/);
    assert.doesNotMatch(invalidText, /<<<QG_(?:TOOL|END)_/);
    assert.doesNotMatch(invalidText, /"command":""/);
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic streaming strips XML artifacts from text deltas', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  accounts.push({
    email: 'xml-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_context.txt',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const stream = new ReadableStream({
        start(c) {
          // Legacy XML syntax is ordinary text under the nonce-only protocol.
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"phase":"answer","content":"I\'ll check the file. <function=Bash><parameter=command>cat /etc/hostname</parameter></function>"}}]}\n\n',
            ),
          );
          c.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"phase":"answer","content":" The hostname is qwen-gate.","status":"finished"}}]}\n\n'),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Check hostname' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200, `Expected 200 got ${res.status}`);

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Legacy XML is preserved as ordinary text and never becomes tool_use.
    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    const text = textDeltas.map((e) => e.delta.text).join('');
    assert.match(text, /<function=Bash>/);
    assert.match(text, /The hostname is qwen-gate/);
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.strictEqual(toolStart, undefined, 'legacy XML must not create tool_use');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic /v1/messages streaming nonce envelope emits correct tool_use block', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.7-max', owned_by: 'qwen' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/getstsToken')) {
      return new Response(
        JSON.stringify({
          data: {
            access_key_id: 'test-key',
            access_key_secret: 'test-secret',
            security_token: 'test-token',
            bucketname: 'test-bucket',
            region: 'oss-cn-hangzhou',
            endpoint: 'oss-cn-hangzhou.aliyuncs.com',
            file_id: 'test-file-id',
            file_path: 'test-user/test-file-id_context.txt',
            file_url: 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/test-file-id_context.txt',
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('aliyuncs.com') || url.includes('oss-')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('/api/v2/files/parse/status')) {
      return new Response(JSON.stringify({ data: [{ status: 'success' }] }), { status: 200 });
    }
    if (url.includes('/api/v2/files/parse')) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      const upstreamPayload = JSON.parse(String(init?.body || '{}'));
      const prompt = String(upstreamPayload.messages?.[0]?.content || '');
      const nonce = prompt.match(/<<<QG_TOOL_([0-9a-f]{16})>>>/)?.[1];
      assert.ok(nonce, 'Upstream prompt must contain a request nonce');
      const envelope = `<<<QG_TOOL_${nonce}>>>{"tool_calls":[{"name":"Bash","arguments":{"command":"ls -la /tmp"}}]}<<<QG_END_${nonce}>>>`;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: envelope, status: 'finished' } }] })}\n\n`,
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      ],
      messages: [{ role: 'user', content: 'Run ls in /tmp' }],
    };

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(
      res.status,
      200,
      `Expected 200 got ${res.status} 鈥?body: ${await res
        .clone()
        .text()
        .catch(() => '?')}`,
    );

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let allSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allSse += decoder.decode(value, { stream: true });
    }

    // Parse all SSE events
    const events: any[] = [];
    for (const line of allSse.split('\n')) {
      if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(line.slice(6)));
        } catch {
          /* skip partial */
        }
      }
    }

    // Verify message_start
    const msgStart = events.find((e) => e.type === 'message_start');
    assert.ok(msgStart, 'Should have message_start');
    assert.strictEqual(msgStart.message.role, 'assistant');

    // Find tool_use content block 鈥?per spec, input is {} in start event
    const toolStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
    assert.ok(toolStart, `Should have tool_use content_block_start 鈥?types: ${[...new Set(events.map((e) => e.type))].join(', ')}`);
    assert.strictEqual(toolStart.content_block.name, 'Bash', `Tool name should be Bash. Got: ${toolStart.content_block.name}`);
    assert.deepStrictEqual(toolStart.content_block.input, {}, 'tool_use start must have empty input per spec');

    // Verify input_json_delta carries the actual args
    const inputDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta');
    assert.ok(inputDeltas.length >= 1, 'Should have at least one input_json_delta');
    const parsedInput = JSON.parse(inputDeltas[0].delta.partial_json);
    assert.strictEqual(parsedInput.command, 'ls -la /tmp', `input_json_delta must have command. Got: ${JSON.stringify(parsedInput)}`);

    // Verify message_delta stop_reason
    const msgDelta = events.find((e) => e.type === 'message_delta');
    assert.ok(msgDelta, 'Should have message_delta');
    assert.strictEqual(msgDelta.delta.stop_reason, 'tool_use');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI streaming: quota_limit upstream error is surfaced as error, not masked as stop', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'quota-test@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max-preview', owned_by: 'qwen' }] }), { status: 200 });
    }
    const uploadMock = mockUploadEndpoints(url);
    if (uploadMock) return uploadMock;
    if (url.includes('/api/v2/chat/completions')) {
      // Qwen rejects with an in-stream error SSE event (high demand), then closes.
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"error": {"code": "quota_limit", "message": "The service is currently experiencing high demand. Please try again later."}}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'Do the thing' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let sawErrorEvent = false;
    let sawFinishStop = false;
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.trim() === 'data: [DONE]') {
          sawDone = true;
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          if (data.error) sawErrorEvent = true;
          if (data.choices?.[0]?.finish_reason === 'stop') sawFinishStop = true;
        } catch {
          /* partial JSON ignored */
        }
      }
    }

    assert.ok(sawErrorEvent, 'Client should receive an SSE error event');
    assert.ok(sawDone, 'Stream should terminate with [DONE]');
    assert.strictEqual(
      sawFinishStop,
      false,
      'quota_limit must NOT be masked as a clean finish_reason:stop — downstream would treat the task as completed',
    );
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI non-streaming: quota_limit upstream error returns error response, not empty stop', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'quota-ns@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max-preview', owned_by: 'qwen' }] }), { status: 200 });
    }
    const uploadMock = mockUploadEndpoints(url);
    if (uploadMock) return uploadMock;
    if (url.includes('/api/v2/chat/completions')) {
      // Qwen rejects with an in-stream error SSE event (high demand), then closes.
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"error": {"code": "quota_limit", "message": "The service is currently experiencing high demand. Please try again later."}}\n\n',
            ),
          );
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'Do the thing' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    // Must NOT be a 200 with empty stop content — must be a real error response.
    assert.notStrictEqual(res.status, 200, 'quota_limit must not be masked as a 200 stop with empty content');
    const body = await res.json();
    assert.ok(body.error, 'Response should carry an error object');
    assert.strictEqual(body.error.upstream_code, 'quota_limit');
    assert.match(body.error.message || '', /high demand/);
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI streaming: upstream empty stream surfaces error, not clean stop', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'empty-stream@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max-preview', owned_by: 'qwen' }] }), { status: 200 });
    }
    const uploadMock = mockUploadEndpoints(url);
    if (uploadMock) return uploadMock;
    if (url.includes('/api/v2/chat/completions')) {
      // Qwen returns 200 + [DONE] with NO content chunks at all — the "empty
      // stream" pattern seen with long conversations.
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'Do the thing' }],
      stream: true,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let sawErrorEvent = false;
    let sawFinishStop = false;
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.trim() === 'data: [DONE]') {
          sawDone = true;
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          if (data.error) sawErrorEvent = true;
          if (data.choices?.[0]?.finish_reason === 'stop') sawFinishStop = true;
        } catch {
          /* partial JSON ignored */
        }
      }
    }

    assert.ok(sawErrorEvent, 'Empty stream should produce an error event, not a clean stop');
    assert.ok(sawDone, 'Stream should terminate with [DONE]');
    assert.strictEqual(
      sawFinishStop,
      false,
      'Empty stream must NOT be masked as finish_reason:stop — Claude Code would loop "please produce output"',
    );
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});

test('OpenAI non-streaming: upstream empty response returns error, not clean stop', async () => {
  const originalFetch = globalThis.fetch;
  const originalAccounts = [...accounts];

  // Seed a test account
  accounts.push({
    email: 'empty-ns@qwen-gate.dev',
    password: 'test',
    state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
  });

  (globalThis as any).fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-max-preview', owned_by: 'qwen' }] }), { status: 200 });
    }
    const uploadMock = mockUploadEndpoints(url);
    if (uploadMock) return uploadMock;
    if (url.includes('/api/v2/chat/completions')) {
      // Qwen returns 200 + [DONE] with NO content chunks — the non-streaming
      // "empty response" pattern (fast ~5s zero-content stops seen in live logs).
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input);
  };

  try {
    const payload = {
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'Do the thing' }],
      stream: false,
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    });

    const res = await app.fetch(req);
    // Must NOT be a 200 with empty stop content — must be a real error response.
    assert.notStrictEqual(res.status, 200, 'empty response must not be masked as a 200 stop with empty content');
    const body = await res.json();
    assert.ok(body.error, 'Response should carry an error object');
    assert.strictEqual(body.error.code, 'upstream_empty');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    globalThis.fetch = originalFetch;
  }
});
