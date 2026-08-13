import { describe, it } from 'bun:test';
import { strict as assert } from 'node:assert';
import { cleanTextOfXmlArtifacts } from './xmlToolParser.ts';

describe('xmlToolParser - orphan tool_result echo', () => {
  it('strips an unclosed <tool_result> opening and all following echoed content', () => {
    const input = [
      '前面内容',
      '<tool_result tool="shell_command" success="true">',
      'git diff --cached',
      'fake diff',
      '后续内容',
    ].join('\n');
    const result = cleanTextOfXmlArtifacts(input);
    assert.ok(result.cleanedText.includes('前面内容'));
    assert.ok(!result.cleanedText.includes('git diff'));
    assert.ok(!result.cleanedText.includes('fake diff'));
    assert.ok(!result.cleanedText.includes('<tool_result'));
  });
});
