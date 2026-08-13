import { describe, it } from 'bun:test';
import { strict as assert } from 'node:assert';
import { cleanTextOfXmlArtifacts, parseXmlToolCalls } from './xmlToolParser.ts';

describe('xmlToolParser - <function_calls> format', () => {
  it('parses execute_command from the newer function_calls envelope', () => {
    const input = [
      '先执行检查。',
      '<function_calls>',
      '<invoke name="execute_command">',
      '<parameter name="command">cd "J:\\Program Files (x86)\\qwen-gate" && git status</parameter>',
      '<parameter name="sandbox_permissions">require_escalated</parameter>',
      '</invoke>',
      '</function_calls>',
      '后续内容',
    ].join('\n');

    const { toolCalls, cleanedText } = parseXmlToolCalls(input);
    assert.strictEqual(toolCalls.length, 1);
    assert.strictEqual(toolCalls[0].name, 'execute_command');
    assert.strictEqual(toolCalls[0].parameters.command, 'cd "J:\\Program Files (x86)\\qwen-gate" && git status');
    assert.ok(cleanedText.includes('先执行检查。'));
    assert.ok(cleanedText.includes('后续内容'));
  });

  it('strips the function_calls envelope without leaking command values', () => {
    const input = [
      '先执行检查。',
      '<function_calls>',
      '<invoke name="execute_command">',
      '<parameter name="command">git diff --stat</parameter>',
      '</invoke>',
      '</function_calls>',
      '后续内容',
    ].join('\n');
    const result = cleanTextOfXmlArtifacts(input);
    assert.ok(result.cleanedText.includes('先执行检查。'));
    assert.ok(result.cleanedText.includes('后续内容'));
    assert.ok(!result.cleanedText.includes('git diff'));
    assert.ok(!result.cleanedText.includes('function_calls'));
    assert.ok(!result.cleanedText.includes('execute_command'));
  });
});
