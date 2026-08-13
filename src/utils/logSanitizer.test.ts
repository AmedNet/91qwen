import assert from 'node:assert';
import { test } from 'node:test';
import {
  sanitizeLogChunks,
  sanitizeLogHeaders,
  sanitizeLogSsePreview,
  sanitizeLogText,
  sanitizeLogValue,
} from './logSanitizer.ts';

test('sanitizeLogText redacts signed URLs and strips leaked LLM scaffolding', () => {
  const text = [
    '<assist>',
    '<thinking>secret plan</thinking>',
    '<function=shell_command>',
    '<parameter=command>cat secret</parameter>',
    '</function>',
    'real answer',
    'https://example.com/file.txt?x-oss-security-token=CAISsecret&x-oss-signature=abc123&ok=1',
  ].join('\n');

  const output = sanitizeLogText(text, 500);

  assert.ok(!output.includes('secret plan'));
  assert.ok(!output.includes('CAISsecret'));
  assert.ok(!output.includes('abc123'));
  assert.ok(!output.includes('<function=shell_command>'));
  assert.ok(!output.includes('<assist>'));
  assert.ok(output.includes('real answer'));
  assert.ok(output.includes('x-oss-security-token=%5BREDACTED%5D'));
});

test('sanitizeLogHeaders redacts cookie and authorization values', () => {
  assert.deepStrictEqual(
    sanitizeLogHeaders({
      'Set-Cookie': 'session=abc',
      Authorization: 'Bearer token',
      'X-Test': 'ok',
    }),
    {
      'Set-Cookie': '[REDACTED]',
      Authorization: '[REDACTED]',
      'X-Test': 'ok',
    },
  );
});

test('sanitizeLogValue truncates and sanitizes nested message content', () => {
  const value = {
    messageCount: 2,
    messages: [
      { role: 'user', content: '<assist><thinking>hidden</thinking>hello' },
      { role: 'tool', content: 'a'.repeat(1200) },
    ],
  };

  const output = sanitizeLogValue(value, 500) as any;
  assert.strictEqual(output.messages[0].content.includes('<assist>'), false);
  assert.ok(output.messages[1].content.includes('[truncated'));
});

test('sanitizeLogText removes malformed parameter blocks and tagless tool result echo', () => {
  const text = [
    '拿到文件列表了',
    '<parameter=shell_command>',
    '<parameter=command>git diff --cached</parameter>',
    '<parameter=workdir>J:\\Program Files (x86)\\qwen-gate</parameter>',
    '<parameter=timeout_ms>30000</parameter>',
    '</function>',
    'tool_result tool_name="shell_command" success="true">',
    '<command>shell_command</command>',
    '<stdout>secret output</stdout>',
    '</tool_result>',
    '真实回答',
  ].join('\n');

  const output = sanitizeLogText(text, 500);
  assert.ok(!output.includes('git diff'));
  assert.ok(!output.includes('Program Files'));
  assert.ok(!output.includes('30000'));
  assert.ok(!output.includes('secret output'));
  assert.ok(!output.includes('<parameter'));
  assert.ok(!output.includes('</function>'));
  assert.ok(!output.includes('tool_result'));
  assert.ok(output.includes('拿到文件列表了'));
  assert.ok(output.includes('真实回答'));
});

test('sanitizeLogChunks suppresses split tool and result echo fragments across chunks', () => {
  const chunks = [
    '我先执行命令。',
    '<function',
    '=shell_command>',
    '\n<parameter=',
    'command>git diff --cached</parameter>',
    '<parameter=workdir>J:\\Program Files',
    '</function>',
    'tool_result tool',
    '_name="shell_command" success="true">',
    '<stdout>secret output</stdout>',
    '</tool_result>',
    '真实回答',
  ];

  const output = sanitizeLogChunks(chunks).join('');
  assert.ok(output.includes('我先执行命令。'));
  assert.ok(output.includes('真实回答'));
  assert.ok(!output.includes('<function'));
  assert.ok(!output.includes('=shell_command'));
  assert.ok(!output.includes('git diff'));
  assert.ok(!output.includes('secret output'));
  assert.ok(!output.includes('<parameter'));
});

test('sanitizeLogSsePreview removes tool content across SSE event boundaries', () => {
  const preview = [
    'data: {"choices":[{"delta":{"phase":"answer","content":"真实回答"}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"<function"}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"=shell_command>"}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"git diff --cached"}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"</function>"}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"后续内容"}}]}',
  ].join('\n');

  const output = sanitizeLogSsePreview(preview);
  assert.ok(output.includes('真实回答'));
  assert.ok(output.includes('后续内容'));
  assert.ok(!output.includes('<function'));
  assert.ok(!output.includes('=shell_command'));
  assert.ok(!output.includes('git diff'));
});
