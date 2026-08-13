import type { ParsedToolCall } from '../types/openai.ts';
import { logStore } from './logStore.ts';
import type { QwenPayload } from './qwen.ts';
import { sanitizeLogHeaders, sanitizeLogSsePreview, sanitizeLogText, sanitizeLogValue } from '../utils/logSanitizer.ts';

let qwenLogDir: string | undefined;
let qwenWriteCount = 0;

export function initQwenLogger(dir: string): void {
  qwenLogDir = dir;
}

function ensureLogDir(): string | undefined {
  if (!qwenLogDir) return undefined;
  try {
    const { mkdirSync } = require('node:fs');
    mkdirSync(qwenLogDir, { recursive: true });
    return qwenLogDir;
  } catch {
    return undefined;
  }
}

function maybeCleanup(dir: string): void {
  try {
    const { readdirSync, unlinkSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const files = readdirSync(dir);
    if (files.length < 500) return;

    const entries = files
      .map((f: string) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => a.mtime - b.mtime);

    const toRemove = entries.slice(0, entries.length - 400);
    for (const entry of toRemove) {
      try {
        unlinkSync(entry.path);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* cleanup is best-effort */
  }
}

function writeJsonFile(dir: string, name: string, data: unknown): void {
  try {
    const { join } = require('node:path');
    const { writeFileSync } = require('node:fs');
    const filePath = join(dir, name);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');

    qwenWriteCount++;
    if (qwenWriteCount % 50 === 0) {
      maybeCleanup(dir);
    }
  } catch (err) {
    logStore.log('warn', 'qwenLogger', `Failed to write ${name}: ${(err as Error).message}`);
  }
}

export function logQwenRequest(payload: QwenPayload, url: string): string {
  const dir = ensureLogDir();
  if (!dir) return '';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `req_${timestamp}_${Date.now()}.json`;
  const requestId = fileName.replace(/\.json$/, '');

  const sanitizedPayload = sanitizeLogValue(payload);
  writeJsonFile(dir, fileName, {
    requestId,
    timestamp: new Date().toISOString(),
    url,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      origin: 'https://chat.qwen.ai',
      referer: 'https://chat.qwen.ai/',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      version: '0.2.66',
    },
    payload: sanitizedPayload,
  });

  return requestId;
}

export function logQwenResponse(
  requestFile: string,
  status: number,
  statusText: string,
  headers: Record<string, string>,
  responsePreview: string,
): void {
  const dir = ensureLogDir();
  if (!dir) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = requestFile.replace(/\.json$/, '');
  const fileName = `${baseName}_resp_${timestamp}.json`;

  writeJsonFile(dir, fileName, {
    requestFile,
    timestamp: new Date().toISOString(),
    status,
    statusText,
    headers: sanitizeLogHeaders(headers),
    responsePreview: responsePreview.includes('\ndata: ') || responsePreview.startsWith('data: ')
      ? sanitizeLogSsePreview(responsePreview)
      : sanitizeLogText(responsePreview, 50000),
  });
}

export function logQwenSSE(logFile: string | undefined, sseEvents: number, toolCallEvents: number, toolCalls: ParsedToolCall[]): void {
  const dir = ensureLogDir();
  if (!dir || !logFile) return;

  const baseName = logFile.replace(/\.json$/, '');
  const fileName = `${baseName}_sse.json`;

  writeJsonFile(dir, fileName, {
    requestFile: logFile,
    timestamp: new Date().toISOString(),
    sseEvents,
    toolCallEvents,
    toolCalls: sanitizeLogValue(toolCalls, 2000),
  });
}
