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
    test('does NOT include reasoning_content in assistant replay', () => {
      const messages = [
        { role: 'user', content: 'Question' },
        {
          role: 'assistant',
          content: 'Answer',
          reasoning_content: 'This is my thinking process...',
        },
        { role: 'user', content: 'Follow up' },
      ];

      const body = { model: 'qwen3.7-max' };
      const result = buildQwenMessages(messages, body, 10000, false);
      const content = result.qwenMessages[0].content as string;

      expect(content).toContain('Answer');
      expect(content).not.toContain('This is my thinking process');
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
