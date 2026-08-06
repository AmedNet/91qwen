import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';

const CAPTURE_DIR = '.qwen/captures';
const MAX_CAPTURES = 100;

// Ensure capture directory exists once
if (!existsSync(CAPTURE_DIR)) {
  mkdirSync(CAPTURE_DIR, { recursive: true });
}

/** Serialise headers — strip auth tokens so captures are safe to share. */
function sanitiseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    if (k === 'authorization' || k === 'x-api-key') {
      out[k] = '***REDACTED***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Hono middleware: captures every POST/PUT/PATCH request + response to
 * .qwen/captures/<timestamp>-<id>.json for replay debugging.
 *
 * The updated version also captures the RESPONSE (including SSE streams)
 * by monkey-patching the Response body stream.
 */
export const captureMiddleware: MiddlewareHandler = async (c, next) => {
  const url = c.req.url;
  const method = c.req.method;

  // Only capture API requests — skip healthchecks, dashboard assets, etc.
  if (!url.includes('/v1/') && !url.includes('/api/')) return next();

  // Clone the raw Request to read its body without consuming the
  // original stream — otherwise downstream c.req.json() returns a string.
  const cloned = c.req.raw.clone();
  const reqBody = await cloned.text().catch(() => '(unable to read body)');

  const captureId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fname = `${timestamp.replace(/[:.]/g, '-')}-${captureId.substring(0, 8)}.json`;

  const capture: any = {
    id: captureId,
    timestamp,
    method,
    url,
    headers: sanitiseHeaders(c.req.raw.headers),
    body: reqBody.length < 2_000_000 ? reqBody : `[TRUNCATED: ${reqBody.length} bytes]`,
    bodyLength: reqBody.length,
  };

  // Run the request handler
  await next();

  // Capture the response
  const resp = c.res;
  capture.response = {
    status: resp?.status ?? 0,
    headers: {},
  };

  // Clone the response to read its body (if it has one)
  const rawResp = c.res?.raw;
  if (rawResp) {
    try {
      const respClone = rawResp.clone();
      const respBody = await respClone.text();
      const maxLen = 2_000_000;
      capture.response.body = respBody.length > maxLen
        ? `⚠ Response too large (${respBody.length} bytes) — save separate file`
        : respBody;
      capture.response.bodyLength = respBody.length;

      // If response > 2MB, save it as a separate file
      if (respBody.length > maxLen) {
        const bigFname = fname.replace('.json', '.response.txt');
        writeFileSync(`${CAPTURE_DIR}/${bigFname}`, respBody, 'utf-8');
        capture.response.file = bigFname;
      }
    } catch {
      capture.response.body = '(unable to read response body)';
    }
  }

  writeFileSync(`${CAPTURE_DIR}/${fname}`, JSON.stringify(capture, null, 2), 'utf-8');

  // Keep only the most recent MAX_CAPTURES
  try {
    const fs = await import('node:fs');
    const files = fs.readdirSync(CAPTURE_DIR).filter((f: string) =>
      f.endsWith('.json') || f.endsWith('.dedup.txt')
    );
    if (files.length > MAX_CAPTURES) {
      files
        .sort()
        .slice(0, files.length - MAX_CAPTURES)
        .forEach((f: string) => {
          try { fs.unlinkSync(`${CAPTURE_DIR}/${f}`); } catch {}
        });
    }
  } catch {}
};