/**
 * Regression tests: tool call visibility in the Qwen prompt.
 *
 * Root cause (production data: ast_tc=0 while history_tool>0): clients send
 * tool results WITHOUT the assistant tool_calls that issued them.
 * buildQwenMessages used to:
 *   1. Not synthesize the missing assistant call -> the model could not see
 *      what it had just invoked and re-called the same tool in a loop.
 *   2. Put results ONLY in the uploaded context.txt attachment -> outcomes
 *      never appeared inline in the conversation flow.
 *
 * NOTE: XML tag literals in the assertions below are built via string
 * concatenation so this source file never contains raw tool-call markup.
 */
import { describe, expect, test } from 'bun:test';
import { buildQwenMessages } from './chatHelpers.ts';

const MINIMAL_BODY = { model: 'qwen3.7-max', thinkingLevel: 'off' as const };

const FN_OPEN = '<' + 'function=';
const PARAM_OPEN = '<' + 'parameter=';
const PARAM_CLOSE = '</' + 'parameter>';

describe('buildQwenMessages tool visibility', () => {
  test('orphan tool result synthesizes a call and inlines the result', () => {
    const messages = [
      { role: 'user', content: 'run ls' },
      { role: 'tool', tool_call_id: 'call_abc', content: 'file1.ts\nfile2.ts' },
    ];
    const { qwenMessages } = buildQwenMessages(messages, MINIMAL_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;

    // Synthesized assistant call block (no matching tool_call in history)
    expect(prompt).toContain('<assist>');
    expect(prompt).toContain(FN_OPEN + 'unknown>');
    // Inline result immediately after the call
    expect(prompt).toContain('<tool_result tool="unknown" success="true">');
    expect(prompt).toContain('file1.ts');
    expect(prompt).toContain('file2.ts');
  });

  test('matched tool result renders call + inline result, no duplicate synthesis', () => {
    const messages = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_xyz', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_xyz', content: 'export const x = 1;' },
    ];
    const { qwenMessages, toolResultsContent } = buildQwenMessages(messages, MINIMAL_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;

    // Assistant turn renders the XML call with args
    expect(prompt).toContain(FN_OPEN + 'Read>');
    expect(prompt).toContain(PARAM_OPEN + 'file_path>/tmp/a.ts' + PARAM_CLOSE);
    // Result inlined under the resolved tool name
    expect(prompt).toContain('<tool_result tool="Read" success="true">');
    expect(prompt).toContain('export const x = 1;');
    // No orphan synthesis for a matched result
    expect(prompt).not.toContain(FN_OPEN + 'unknown>');
    // context.txt archive keeps the full result + the call arguments
    expect(toolResultsContent).toContain('<tool_result tool="Read"');
    expect(toolResultsContent).toContain('<arguments>');
    expect(toolResultsContent).toContain('file_path');
  });

  test('inline tool result content is XML-escaped', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'call_esc', name: 'Bash', content: 'a < b && c > d' },
    ];
    const { qwenMessages } = buildQwenMessages(messages, MINIMAL_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;
    expect(prompt).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(prompt).toContain('<tool_result tool="Bash" success="true">');
  });
});

describe('anthropicMessagesToOpenAI tool_result content', () => {
  test('array-form tool_result content is preserved (was dropped to empty)', async () => {
    const { anthropicMessagesToOpenAI } = await import('./anthropic.ts');
    const out = anthropicMessagesToOpenAI([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'hello from tool' }],
          },
        ],
      },
    ]);
    const toolMsg = out.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('toolu_1');
    expect(toolMsg.content).toContain('hello from tool');
  });

  test('string-form tool_result content still works', async () => {
    const { anthropicMessagesToOpenAI } = await import('./anthropic.ts');
    const out = anthropicMessagesToOpenAI([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'plain string result' }],
      },
    ]);
    const toolMsg = out.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe('plain string result');
  });
});
