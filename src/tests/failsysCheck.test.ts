import { describe, expect, test } from 'bun:test';
import { parseQwenErrorPayload } from '../routes/chatHelpersCore.ts';

const FAIL_SYS = JSON.stringify({
  ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::some-msg'],
  data: { url: 'https://chat.qwen.ai:443//api/v2/chat/completions/_____tmd_____/punish?...' },
});

describe('parseQwenErrorPayload FAIL_SYS', () => {
  test('detects FAIL_SYS_USER_VALIDATE captcha', () => {
    const r = parseQwenErrorPayload(FAIL_SYS);
    expect(r).not.toBeNull();
    expect(r!.code).toBe('waf_captcha');
    expect(r!.upstreamCode).toBe('FAIL_SYS_USER_VALIDATE');
  });
  test('detects via SSE data: prefix', () => {
    const r = parseQwenErrorPayload('data: ' + FAIL_SYS);
    expect(r?.upstreamCode).toBe('FAIL_SYS_USER_VALIDATE');
  });
  test('still returns null for normal payloads', () => {
    expect(parseQwenErrorPayload('{"choices":[]}')).toBeNull();
    expect(parseQwenErrorPayload('[DONE]')).toBeNull();
  });
});
