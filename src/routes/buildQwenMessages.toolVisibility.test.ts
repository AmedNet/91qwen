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

// ── no-thinking tool-call depth limit ─────────────────────────────
// Only active when:
//   1. thinkingLevel === 'off' (or -no-thinking model suffix)
//   2. The request registered at least one tool
//   3. The history contains at least one assistant tool-call turn
// Then: assistant turns ranked >= DEPTH_LIMIT (3) downgrade to prose,
// and their matching tool_result blocks downgrade to prose in lockstep.
// Thinking models: no downgrade regardless of history length.
describe('buildQwenMessages no-thinking depth limit', () => {
  const FN_OPEN = '<' + 'function=';
  const NO_THINK_BODY = {
    model: 'qwen3.7-max-no-thinking',
    thinkingLevel: 'off' as const,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
  };
  const THINK_BODY = {
    model: 'qwen3.7-max',
    thinkingLevel: 'summary' as const,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
  };

  // Build N assistant+tool turns, each with a unique tool_call_id.
  function buildLongHistory(n: number): any[] {
    const msgs: any[] = [{ role: 'user', content: 'go' }];
    for (let k = 0; k < n; k++) {
      msgs.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call_${k}`, type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/' + k + '.ts"}' } }],
      });
      msgs.push({ role: 'tool', tool_call_id: `call_${k}`, content: `result ${k}` });
    }
    msgs.push({ role: 'user', content: 'now write a summary' });
    return msgs;
  }

  test('no-thinking + 5 turns: oldest 2 assistant calls downgrade to prose, tool results in lockstep', () => {
    const messages = buildLongHistory(5);
    const { qwenMessages } = buildQwenMessages(messages, NO_THINK_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;

    // DEPTH_LIMIT=3, so ranks 0,1,2 keep XML; ranks 3,4 downgrade.
    // Rank 0 = most recent assistant turn = the one right before the final user turn.
    // Rank 4 = oldest turn.

    // Recent (rank 0,1,2) keep XML.
    expect(prompt).toContain(FN_OPEN + 'Read>');

    // Oldest (rank 3,4) downgrade — count prose downgrades. The
    // [Previously called the `Read` tool (earlier) ...] label is the
    // signature; the (earlier) tag distinguishes depth-downgrade from
    // unregistered-downgrade.
    const earlierMatches = prompt.match(/Previously called the `Read` tool \(earlier\)/g) || [];
    expect(earlierMatches.length).toBe(2);

    // Matching tool results also downgrade. Both sides must move in
    // lockstep — otherwise the model sees a <tool_result> referencing
    // a call that's no longer in the prompt.
    const resultProseMatches = prompt.match(/Result for the earlier `Read` tool/g) || [];
    expect(resultProseMatches.length).toBe(2);

    // Sanity: no (unregistered) labels — Read IS in registeredTools.
    expect(prompt).not.toContain('unregistered');
  });

  test('thinking model: depth limit inactive, all 5 assistant calls stay XML', () => {
    const messages = buildLongHistory(5);
    const { qwenMessages } = buildQwenMessages(messages, THINK_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;

    // Zero prose downgrades.
    expect(prompt).not.toContain('(earlier)');
    expect(prompt).not.toContain('(unregistered)');
    // All 5 calls serialize as XML.
    const xmlCalls = prompt.match(new RegExp(FN_OPEN + 'Read>', 'g')) || [];
    expect(xmlCalls.length).toBe(5);
  });

  test('no-thinking + exactly DEPTH_LIMIT (3) turns: none downgrade (rank < 3 keeps XML)', () => {
    const messages = buildLongHistory(3);
    const { qwenMessages } = buildQwenMessages(messages, NO_THINK_BODY, 100000, true);
    const prompt = qwenMessages[0].content as string;
    expect(prompt).not.toContain('(earlier)');
    const xmlCalls = prompt.match(new RegExp(FN_OPEN + 'Read>', 'g')) || [];
    expect(xmlCalls.length).toBe(3);
  });

  test('no-thinking + no registered tools: depth limit inactive (matches existing unregistered rationale)', () => {
    // Mirror the existing rule: without body.tools there's nothing to
    // re-execute upstream, so historical XML is safe regardless of depth.
    const messages = buildLongHistory(5);
    const body = { model: 'qwen3.7-max-no-thinking', thinkingLevel: 'off' as const, tools: [] };
    const { qwenMessages } = buildQwenMessages(messages, body, 100000, true);
    const prompt = qwenMessages[0].content as string;
    expect(prompt).not.toContain('(earlier)');
    const xmlCalls = prompt.match(new RegExp(FN_OPEN + 'Read>', 'g')) || [];
    expect(xmlCalls.length).toBe(5);
  });
});
