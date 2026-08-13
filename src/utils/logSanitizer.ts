import { LLM_STRUCTURE_TAGS } from './tagNames.ts';
import { stripToolCallArtifacts } from './xmlStripper.ts';

const MAX_LOG_STRING = 1000;

const SENSITIVE_QUERY_PARAMS = new Set([
  'x-oss-security-token',
  'x-oss-signature',
  'x-oss-credential',
  'token',
  'authorization',
  'api_key',
  'password',
  'secret',
  'signature',
  'sig',
  'credential',
  'access_token',
  'id_token',
  'refresh_token',
]);

const SENSITIVE_HEADER_NAMES = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'x-request-id',
  'x-oss-security-token',
]);

const STRUCTURE_OPEN_RE = new RegExp(`<(?:${LLM_STRUCTURE_TAGS.join('|')})(?:\\s[^>]*)?>`, 'gi');
const STRUCTURE_CLOSE_RE = new RegExp(`</(?:${LLM_STRUCTURE_TAGS.join('|')})>`, 'gi');

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let out = text.replace(
    /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    '[JWT_REDACTED]',
  );
  out = out.replace(
    /\b(x-oss-security-token|x-oss-signature|x-oss-credential|token|authorization|api_key|password|secret|signature|sig|credential|access_token|id_token|refresh_token)=[^&\s"'<>]+/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match));
  return out;
}

export function sanitizeLogText(text: string, maxLength = MAX_LOG_STRING): string {
  if (!text) return text;
  const redacted = redactSensitiveText(text);
  const withoutStructure = stripToolCallArtifacts(redacted)
    .replace(STRUCTURE_OPEN_RE, '')
    .replace(STRUCTURE_CLOSE_RE, '');
  return truncate(withoutStructure, maxLength);
}

/**
 * Sanitize a stream of raw Qwen chunks as a sequence. Tool-call XML and
 * tagless tool-result echoes are suppressed from the opening fragment through
 * the matching close tag, so split-tag command values cannot leak into logs.
 */
export function sanitizeLogChunks(chunks: string[]): string[] {
  let inToolBlock = false;
  let inResultEcho = false;

  return chunks.map((chunk) => {
    if (inToolBlock || inResultEcho) {
      if (/<\/function>/.test(chunk)) inToolBlock = false;
      if (/<\/function_calls>/.test(chunk)) inToolBlock = false;
      if (/<\/(?:tool_result|tool_call|tool_use)>/.test(chunk)) inResultEcho = false;
      return '';
    }

    if (/<function=|<function_calls|<invoke|<parameter=|<function(?=\s|<|$)|<\/function>|<\/function_calls>|<\/invoke>/.test(chunk)) {
      inToolBlock = !/<\/function>/.test(chunk) && !/<\/function_calls>/.test(chunk);
      return '';
    }

    if (/(?:^|\n)\s*(?:tool_(?:result|call|use)\b|="[A-Za-z_]+"\s+success="[^"]*">)/.test(chunk)) {
      inResultEcho = true;
      if (/<\/(?:tool_result|tool_call|tool_use)>/.test(chunk)) inResultEcho = false;
      return '';
    }

    return sanitizeLogText(chunk, 1000);
  });
}

/**
 * Sanitize a raw Qwen SSE preview while preserving its event structure.
 * Tool-call content is replaced with an empty delta across event boundaries,
 * so split tags and stdout fragments do not remain in response logs.
 */
export function sanitizeLogSsePreview(preview: string): string {
  if (!preview) return preview;
  const lines = preview.split('\n');
  const contentChunks: string[] = [];
  const contentLineIndexes: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      const content = event?.choices?.[0]?.delta?.content;
      if (typeof content === 'string') {
        contentChunks.push(content);
        contentLineIndexes.push(i);
      }
    } catch {
      /* non-JSON or malformed SSE event; leave it for the text sanitizer */
    }
  }

  if (contentChunks.length === 0) return sanitizeLogText(preview, 50000);

  const sanitized = sanitizeLogChunks(contentChunks);
  const out = [...lines];
  for (let k = 0; k < contentLineIndexes.length; k++) {
    const lineIndex = contentLineIndexes[k];
    try {
      const event = JSON.parse(lines[lineIndex].slice(6));
      if (event?.choices?.[0]?.delta && typeof event.choices[0].delta.content === 'string') {
        event.choices[0].delta.content = sanitized[k] ?? '';
        out[lineIndex] = `data: ${JSON.stringify(event)}`;
      }
    } catch {
      /* keep the original line */
    }
  }

  return sanitizeLogText(out.join('\n'), 50000);
}

export function sanitizeLogHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

export function sanitizeLogValue(value: unknown, maxLength = MAX_LOG_STRING): unknown {
  if (typeof value === 'string') return sanitizeLogText(value, maxLength);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, maxLength));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = sanitizeLogValue(item, maxLength);
    }
    return out;
  }
  return value;
}
