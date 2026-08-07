// Tests for buildQwenMessages boundary-aware truncation and reasoning_content handling
import { describe, expect, test } from 'bun:test';
import { buildQwenMessages } from '../routes/chatHelpers.ts';

describe('buildQwenMessages', () => {
  describe('boundary-aware truncation', () => {
    test('truncates at segment boundary instead of hard character limit', () => {
      const segment1 = 'First message content';
      const segment2 = 'Second message content';
      const longPadding = 'x'.repeat(200);

      const messages = [
        {
          role: 'user',
          content: `<user>\n${segment1}\n</user>\n\n<assist>\n${segment2}\n</assist>\n\n<user>\n${longPadding}\n</user>`,
        },
      ];

      const body = { model: 'qwen3.7-max' };
      const availableTokens = 50; // charLimit = 150 chars

      const result = buildQwenMessages(messages, body, availableTokens, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('[TRUNCATED:');
      expect(content).toMatch(/<user>[\s\S]*<\/user>/);
    });

    test('preserves tool-result segments in output', () => {
      const messages = [
        { role: 'user', content: 'Initial question' },
        {
          role: 'assistant',
          content: 'Let me help',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'read_file', arguments: '{"path":"/test.txt"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'read_file',
          content: 'file content here',
        },
        { role: 'user', content: 'Thanks' },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('<tool-result');
      expect(content).toContain('</tool-result>');
    });

    test('does not truncate when content is within limit', () => {
      const messages = [
        { role: 'user', content: 'Short message' },
        { role: 'assistant', content: 'Short response' },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).not.toContain('[TRUNCATED:');
      expect(content).toContain('Short message');
      expect(content).toContain('Short response');
    });
  });

  describe('reasoning_content handling', () => {
    test('does NOT include reasoning_content in assistant replay (no echo loop)', () => {
      const messages = [
        { role: 'user', content: 'Question' },
        {
          role: 'assistant',
          content: 'Answer',
          reasoning_content: 'This is my thinking process...',
          tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{}' } }],
        },
        { role: 'user', content: 'Follow up' },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('Answer');
      expect(content).not.toContain('This is my thinking process');
      expect(content).not.toContain('[Previous thinking');
      expect(content).not.toContain('<thinking>');
    });

    test('includes assistant content without reasoning_content', () => {
      const messages = [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Helpful response' },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('Helpful response');
      expect(content).toMatch(/<assist>[\s\S]*Helpful response[\s\S]*<\/assist>/);
    });
  });

  describe('nonce tool protocol', () => {
    test('injects one request-scoped JSON envelope protocol', () => {
      const body = {
        model: 'qwen3.7-max',
        tools: [
          {
            type: 'function',
            function: {
              name: 'Bash',
              description: 'Run a command',
              parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
            },
          },
        ],
      };
      const result = buildQwenMessages([{ role: 'user', content: 'Check status' }], body, 10000, true);
      const content = result.qwenMessages[0].content as string;

      expect(result.toolNonce).toMatch(/^[0-9a-f]{16}$/);
      expect(content).toContain(`<<<QG_TOOL_${result.toolNonce}>>>`);
      expect(content).toContain(`<<<QG_END_${result.toolNonce}>>>`);
      expect(content).toContain('<tool-defs>');
      expect(content).toContain('"name":"Bash"');
      expect(content).not.toContain('<function=');
    });

    test('does not suggest an unregistered Bash tool', () => {
      const body = {
        model: 'qwen3.7-max',
        tools: [
          {
            type: 'function',
            function: {
              name: 'Read',
              description: 'Read a file',
              parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
            },
          },
        ],
      };
      const result = buildQwenMessages([{ role: 'user', content: 'Read the config' }], body, 10000, true);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('"name":"Read"');
      expect(content).not.toContain('"name":"Bash"');
      expect(content).toContain('"name":"<registered tool name>"');
    });

    test('replays historical tool calls as inert JSON history', () => {
      const messages = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] },
        { role: 'user', content: 'Continue' },
      ];
      const body = {
        model: 'qwen3.7-max',
        tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: {} } } }],
      };
      const result = buildQwenMessages(messages, body, 10000, true);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('<tool-call-history>{"name":"Bash","arguments":{"command":"pwd"}}</tool-call-history>');
      expect(content).not.toContain('<function=');
    });

    test('returns the protocol preamble separately so truncation can exclude it', () => {
      const body = {
        model: 'qwen3.7-max',
        tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object', properties: {} } } }],
      };
      const result = buildQwenMessages([{ role: 'user', content: 'hi' }], body, 10000, true);
      const content = result.qwenMessages[0].content as string;

      expect(result.toolPrompt).toBeDefined();
      expect(result.toolPrompt).toContain(`<<<QG_TOOL_${result.toolNonce}>>>`);
      expect(content.startsWith(result.toolPrompt!)).toBe(true);
    });

    test('omits the preamble when the request has no tools', () => {
      const result = buildQwenMessages([{ role: 'user', content: 'hi' }], { model: 'qwen3.7-max' }, 10000, false);
      expect(result.toolPrompt).toBeUndefined();
      expect(result.toolNonce).toBeUndefined();
    });
  });

  // Mirrors the inline-truncation logic in chat.ts and anthropic.ts. The nonce
  // preamble is prefixed to the prompt, so without explicit exclusion it is the
  // first segment evicted — which silently strips the protocol the response
  // parsers depend on.
  describe('inline truncation preserves the protocol preamble', () => {
    const MAX_INLINE_CHARS = 50000;
    const CHAT_RE = /\n\n(?=<user>|<assist>)/;
    const ANTHROPIC_RE = /\n\n(?=<user>|<assist>|<tool-result)/;
    const tools = [
      {
        type: 'function',
        function: {
          name: 'Bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      },
    ];

    function truncate(built: ReturnType<typeof buildQwenMessages>, splitRe: RegExp) {
      let inlineContent = built.qwenMessages[0].content as string;
      let chatHistoryContent = '';
      const toolPrompt = built.toolPrompt;

      const preamble = toolPrompt && inlineContent.startsWith(toolPrompt) ? toolPrompt : '';
      if (preamble) inlineContent = inlineContent.slice(preamble.length);

      if (preamble.length + inlineContent.length > MAX_INLINE_CHARS) {
        const budget = Math.max(0, MAX_INLINE_CHARS - preamble.length);
        const parts = inlineContent.split(splitRe);
        let keptLen = 0;
        let splitIdx = parts.length;
        for (let i = parts.length - 1; i >= 0; i--) {
          const addLen = parts[i].length + (keptLen > 0 ? 2 : 0);
          if (keptLen + addLen <= budget) {
            keptLen += addLen;
            splitIdx = i;
          } else break;
        }
        if (splitIdx > 0) {
          chatHistoryContent = parts.slice(0, splitIdx).join('\n\n');
          inlineContent = parts.slice(splitIdx).join('\n\n');
        }
      }

      return { finalContent: preamble + inlineContent, chatHistoryContent };
    }

    function makeMessages(count: number, chars: number) {
      return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i} ` + 'x'.repeat(chars),
      }));
    }

    for (const [label, splitRe] of [['chat.ts', CHAT_RE], ['anthropic.ts', ANTHROPIC_RE]] as const) {
      test(`${label}: keeps the nonce inline when older history is evicted`, () => {
        const built = buildQwenMessages(makeMessages(80, 1000), { model: 'qwen3.7-max', tools }, 100000, true);
        const opener = `<<<QG_TOOL_${built.toolNonce}>>>`;
        expect((built.qwenMessages[0].content as string).length).toBeGreaterThan(MAX_INLINE_CHARS);

        const { finalContent, chatHistoryContent } = truncate(built, splitRe);

        expect(chatHistoryContent.length).toBeGreaterThan(0);
        expect(finalContent).toContain(opener);
        expect(finalContent).toContain('<tool-defs>');
        expect(chatHistoryContent).not.toContain(opener);
        expect(finalContent.length).toBeLessThanOrEqual(MAX_INLINE_CHARS);
      });
    }

    test('keeps the nonce inline when a single message cannot be evicted', () => {
      const built = buildQwenMessages(makeMessages(1, 90000), { model: 'qwen3.7-max', tools }, 100000, true);
      const { finalContent } = truncate(built, CHAT_RE);
      expect(finalContent).toContain(`<<<QG_TOOL_${built.toolNonce}>>>`);
      expect(finalContent).toContain('<tool-defs>');
    });

    test('keeps the nonce inline when no truncation is needed', () => {
      const built = buildQwenMessages(makeMessages(4, 100), { model: 'qwen3.7-max', tools }, 100000, true);
      const { finalContent, chatHistoryContent } = truncate(built, CHAT_RE);
      expect(chatHistoryContent).toBe('');
      expect(finalContent).toBe(built.qwenMessages[0].content as string);
    });

    test('still truncates normally when the request has no tools', () => {
      const built = buildQwenMessages(makeMessages(80, 1000), { model: 'qwen3.7-max' }, 100000, false);
      const { finalContent, chatHistoryContent } = truncate(built, CHAT_RE);
      expect(built.toolPrompt).toBeUndefined();
      expect(chatHistoryContent.length).toBeGreaterThan(0);
      expect(finalContent.length).toBeLessThanOrEqual(MAX_INLINE_CHARS);
    });
  });

  describe('tool result formatting', () => {
    test('formats tool results with proper XML tags', () => {
      const messages = [
        { role: 'user', content: 'Read a file' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_123',
              function: { name: 'Bash', arguments: '{"command":"ls"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          name: 'Bash',
          content: 'file1.txt\nfile2.txt',
        },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('<tool-result tool="Bash">');
      expect(content).toContain('file1.txt');
      expect(content).toContain('</tool-result>');
    });

    test('handles tool errors correctly', () => {
      const messages = [
        { role: 'user', content: 'Try something' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_456',
              function: { name: 'Bash', arguments: '{"command":"invalid"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_456',
          name: 'Bash',
          content: '[ERROR] Command not found',
        },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);

      expect(result.toolResultsContent).toContain('stderr');
      expect(result.toolResultsContent).toContain('Command not found');
    });
  });
});
