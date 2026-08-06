import crypto from 'node:crypto';
import { CircuitBreaker, CircuitOpenError, withRetry } from '../utils/retry.ts';
import { logCrash, logSessionClose } from '../utils/wreqCrashLogger.ts';
import { decrementInFlight, getTokenWithAccount, pickAccount, setAccountDisabled, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { completeEntry, createNetworkEntry, errorEntry, recordResponse, recordStreamChunk } from './networkDebug.ts';
import { logQwenRequest, logQwenResponse } from './qwenLogger.ts';

export { configureAccount, deleteAllChats, fetchQwenModels } from './qwenModels.ts';

// Shared URL constants for Qwen API
export const QWEN_API_BASE = 'https://chat.qwen.ai';
export const QWEN_CHAT_COMPLETIONS_URL = `${QWEN_API_BASE}/api/v2/chat/completions`;
export const QWEN_SETTINGS_URL = `${QWEN_API_BASE}/api/v2/users/user/settings/update`;

/** Build shared feature_config for Qwen message payloads. */
export function buildFeatureConfig(enableThinking: boolean): Record<string, any> {
  return {
    thinking_enabled: enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: false,
    thinking_mode: 'Thinking',
    thinking_format: 'summary',
    auto_search: true,
  };
}
export const QWEN_CHATS_URL = `${QWEN_API_BASE}/api/v2/chats/`;
export const QWEN_MODELS_URL = `${QWEN_API_BASE}/api/models`;
export const QWEN_BX_V = '2.5.36';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

/** Thrown when Qwen rejects a tool call because the LLM used a tool name
 *  that doesn't match any registered tool. This is an LLM mistake, NOT an
 *  account/infra issue — callers should NOT retry with a different account;
 *  they should pass the error back to the LLM so it can correct the name. */
export class QwenToolNotFoundError extends Error {
  readonly upstreamStatus: number;
  constructor(message: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenToolNotFoundError';
    this.upstreamStatus = upstreamStatus;
  }
}

class UpstreamStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamStatusError';
    this.status = status;
  }
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant' | 'function';
  content: string | Record<string, unknown>;
  user_action: string;
  files: unknown[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: Record<string, unknown>;
  extra: Record<string, unknown>;
  sub_chat_type: string;
  parent_id: string | null;
  // Function-specific fields (only for role: 'function')
  model?: string;
  modelName?: string;
  modelIdx?: number;
  userContext?: unknown;
  info?: Record<string, unknown>;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string | null;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
}

export interface QwenStreamResult {
  stream: ReadableStream;
  headers: Record<string, string>;
  uiSessionId: string;
  accountEmail?: string;
  abortController: AbortController;
  qwenLogFile?: string;
}

// Cached timezone for request headers
const cachedTimezone = 'America/Sao_Paulo';

// Stable per-process device fingerprint for the bx-umidtoken fallback. Using
// Date.now() here generated a NEW umid on every request -> mismatched device
// fingerprint -> WAF man-machine challenge. A process-stable value presents one
// consistent "device" across all requests that lack a real extracted umid.
const STABLE_ANON_UMID = crypto.createHash('sha256').update(`qwen-gate-${process.pid}`).digest('hex').slice(0, 64);

export function createFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = config.getInt('QWEN_FETCH_TIMEOUT_MS', 30000);
  if (timeout > 0) {
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeout);
    return { controller, cleanup: () => clearTimeout(timer) };
  }
  return { controller, cleanup: () => {} };
}

function buildRequestHeaders(reqHeaders: Record<string, string>, cId?: string): Record<string, string> {
  const bxUmidtoken =
    reqHeaders['bx-umidtoken'] ||
    crypto
      .createHash('sha256')
      .update(reqHeaders['cookie'] || STABLE_ANON_UMID)
      .digest('hex')
      .slice(0, 64);
  const bxUa =
    reqHeaders['bx-ua'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
    'content-type': 'application/json',
    source: 'web',
    cookie: reqHeaders['cookie'],
    origin: QWEN_API_BASE,
    referer: cId ? `https://chat.qwen.ai/c/${cId}` : 'https://chat.qwen.ai/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    // Client hints — critical for WAF bypass. Real Chrome sends these automatically,
    // but Node.js fetch() doesn't. Adding them manually tells the WAF this is a
    // real browser request.
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    timezone: cachedTimezone,
    'user-agent':
      reqHeaders['user-agent'] ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'x-accel-buffering': 'no',
    'x-request-id': crypto.randomUUID(),
    'bx-ua': bxUa,
    'bx-umidtoken': bxUmidtoken,
    'bx-v': reqHeaders['bx-v'] || QWEN_BX_V,
  };
}

const lastRequestTime = new Map<string, number>();
let lastGlobalRequestTime = 0;
async function applyRequestJitter(accountEmail?: string): Promise<void> {
  // Skip pacing in tests — TEST_MOCK_PLAYWRIGHT mocks the whole Qwen HTTP layer
  // and has no upstream WAF to protect against.
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;

  // Global minimum gap between ANY two requests (200-500ms), regardless of
  // which account they belong to. Without this, 12 accounts can burst
  // concurrently and trigger the Alibaba WAF RGV587 ("被挤爆") threshold.
  // Per-account pacing alone cannot prevent cross-account bursts.
  const now = Date.now();
  const globalElapsed = now - lastGlobalRequestTime;
  const globalMinGap = 300 + Math.floor(Math.random() * 400); // 300-700ms
  if (globalElapsed < globalMinGap) {
    await new Promise((r) => setTimeout(r, globalMinGap - globalElapsed));
  }
  lastGlobalRequestTime = Date.now();

  if (!accountEmail) return;

  const last = lastRequestTime.get(accountEmail) || 0;
  const elapsed = Date.now() - last;

  // Minimum gap between requests from the same account (1-3 seconds)
  const minGap = 1000 + Math.random() * 2000;
  if (elapsed < minGap) {
    const wait = minGap - elapsed + Math.random() * 500;
    await new Promise((r) => setTimeout(r, wait));
  }

  // Occasional longer pause (10% chance of 2-5s delay — simulates user reading/thinking)
  if (Math.random() < 0.1) {
    const pause = 2000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, pause));
  }

  lastRequestTime.set(accountEmail, Date.now());
}

const qwenCircuitBreaker = new CircuitBreaker('qwen-api', {
  // In CDP mode, first requests per context can take longer (baxia warmup).
  // With 8 accounts, we need a higher threshold to avoid premature circuit open.
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 1,
});

export async function createQwenStream(
  messages: QwenMessage[],
  enableThinking: boolean,
  modelId: string,
  chatId?: string,
  parentId?: string | null,
  accountEmail?: string,
  tools?: unknown[],
  toolChoice?: unknown,
): Promise<QwenStreamResult> {
  const actualParentId: string | null = parentId !== undefined ? parentId : null;
  const timestamp = Math.floor(Date.now() / 1000);
  const model = modelId.replace('-no-thinking', '');

  // Ensure each message has required fields
  const qwenMessages: QwenMessage[] = messages.map((msg, i) => ({
    fid: msg.fid || crypto.randomUUID(),
    parentId: msg.parentId || (i === 0 ? actualParentId : null),
    childrenIds: msg.childrenIds || [],
    role: msg.role,
    content: msg.content,
    user_action: msg.user_action || 'chat',
    files: msg.files || [],
    timestamp: msg.timestamp || timestamp,
    models: msg.models || [model],
    chat_type: msg.chat_type || 't2t',
    feature_config: msg.feature_config || buildFeatureConfig(enableThinking),
    extra: msg.extra || { meta: { subChatType: 't2t' } },
    sub_chat_type: msg.sub_chat_type || 't2t',
    parent_id: msg.parent_id ?? (i === 0 ? actualParentId : null),
    // Function-specific fields
    ...(msg.role === 'function'
      ? {
          model: msg.model || model,
          modelName: msg.modelName || modelId,
          modelIdx: msg.modelIdx ?? 0,
          userContext: msg.userContext ?? null,
          info: msg.info || {},
        }
      : {}),
  }));

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId || null,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: qwenMessages,
    timestamp: timestamp + 1,
    // Only send tools via feature_config.local_mcp (Qwen native format).
    // Top-level tools/tool_choice triggers OpenAI compatibility mode which
    // gets intercepted by the Alibaba WAF (RGV587 bot detection).
  };

  const urlObj = new URL(QWEN_CHAT_COMPLETIONS_URL);
  if (chatId) urlObj.searchParams.set('chat_id', chatId);
  const url = urlObj.href;

  const retryConfig = {
    maxRetries: Math.max(0, config.getInt('RETRY_MAX_ATTEMPTS', 3)),
    baseDelayMs: Math.max(0, config.getInt('RETRY_BASE_DELAY_MS', 1000)),
    maxDelayMs: Math.max(0, config.getInt('RETRY_MAX_DELAY_MS', 30000)),
    backoffMultiplier: Math.max(0.1, config.getFloat('RETRY_BACKOFF_MULTIPLIER', 2)),
    attemptTimeoutMs: 30_000,
  };

  const retriesEnabled = config.getBool('RETRY_ENABLED', true);
  let currentAccountEmail = accountEmail;
  let lastDebugEntryId: string | null = null;
  // Most recent attempt's network-debug entry. On a retry, the previous attempt's
  // entry is closed out as superseded so the buffer doesn't fill with dangling pending entries.
  let currentDebugEntryId: string | null = null;
  const streamAbortController = new AbortController();

  async function handleErrorResponse(response: Response, debugEntryId: string): Promise<never> {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';

    // Baxia WAF often answers a captcha challenge as HTML or a bare 403 rather
    // than a JSON FAIL_SYS_USER_VALIDATE. The JSON-only branch below missed it
    // -> generic UpstreamStatusError -> no throttle -> immediate account
    // re-pick -> repeat challenge. Detect it here and treat as captcha.
    // BUT: a genuine auth-failure 403 (expired/bad token) returns a JSON body,
    // not a WAF HTML page — only treat as WAF captcha when there is HTML or an
    // explicit WAF marker, so real auth failures still flow to the JSON branch
    // (which routes them to re-login) instead of being mislabelled as captcha.
    const isHtml = contentType.includes('text/html') || /<html|aliyun_waf/i.test(errText);
    const looksLikeWafHtml =
      (response.status === 403 && isHtml) ||
      /aliyun_waf|<html|man-machine|captcha/i.test(errText);
    if (looksLikeWafHtml) {
      const details = `WAF challenge (status ${response.status}, ${contentType || 'no-ct'})`;
      logStore.log('warn', 'qwen', `CAPTCHA (HTML/403) detected for ${currentAccountEmail || 'unknown'}: ${details}`);
      if (currentAccountEmail) {
        throttleAccount(currentAccountEmail, 5 * 60 * 1000);
        const nextAccount = await pickAccount(currentAccountEmail);
        if (nextAccount) {
          currentAccountEmail = nextAccount.email;
          decrementInFlight(nextAccount.email);
        }
      }
      throw new RetryableQwenStreamError(`Qwen WAF/captcha (HTML/403) — switched accounts. ${details}`, 3000);
    }

    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          errorEntry(debugEntryId, errorJson.data.details);
          throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, retryAfterMs);
        }

        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
          if (code === 'RateLimited') {
            // Daily usage limit reached — permanently disable this account until user re-enables it.
            // The wait time from Qwen is uncertain and can be many hours, so throttling is unreliable.
            if (currentAccountEmail) {
              setAccountDisabled(currentAccountEmail, true);
              logStore.log('warn', 'qwen', `[Qwen] RateLimited: disabled ${currentAccountEmail} — ${details}`);
            } else {
              logStore.log('warn', 'qwen', `[Qwen] RateLimited but currentAccountEmail is empty — cannot disable account. Details: ${details}`);
            }
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              // pickAccount incremented inFlight for the new account, but we're about to throw
              // so decrement it — the caller will retry with a fresh pickAccount
              decrementInFlight(nextAccount.email);
            } else {
              // All accounts are disabled or throttled — include wait time in error for the user
              throw new QwenUpstreamError(`All accounts rate-limited. ${details}.${wait}`, code, 429);
            }
          }
          let status: number;
          if (code === 'RateLimited') status = 429;
          else if (code === 'Not_Found') status = 404;
          else if (code === 'UpstreamError') status = 502;
          else status = 502;
          errorEntry(debugEntryId, `${code}: ${details}`);
          throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}.${wait}`, code, status);
        }

        // Qwen anti-bot CAPTCHA — throttle account and switch
        if (errorJson?.ret?.[0] === 'FAIL_SYS_USER_VALIDATE') {
          const details = errorJson.ret[1] || 'CAPTCHA required';
          logStore.log('warn', 'qwen', `CAPTCHA detected for ${currentAccountEmail || 'unknown'}: ${details}`);
          if (currentAccountEmail) {
            throttleAccount(currentAccountEmail, 5 * 60 * 1000);
            logStore.log(
              'debug',
              'qwen',
              `[Qwen] BOT DETECTION: ${currentAccountEmail} hit FAIL_SYS_USER_VALIDATE — throttled 5min, switching account`,
            );
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              decrementInFlight(nextAccount.email);
            }
          }
          throw new RetryableQwenStreamError(`Qwen CAPTCHA — switched accounts. ${details}`, 3000);
        }

        // Tool-not-found detection: Qwen rejects a tool call because the LLM
        // hallucinated or typo'd a tool name. Must include "tool" or "function"
        // context to avoid false matching on unrelated "not exist" errors like
        // "session does not exist" or "user does not exist".
        const notExistDetails = errorJson?.data?.details || '';
        const isNotExistError = notExistDetails.includes('is not exist') ||
          notExistDetails.includes('not exist') ||
          notExistDetails.includes('does not exist');
        const isToolContext = notExistDetails.includes('Tool') ||
          notExistDetails.includes('tool') ||
          notExistDetails.includes('function') ||
          notExistDetails.includes('Function');
        if (isNotExistError && isToolContext) {
          errorEntry(debugEntryId, errorJson.data.details);

          // ── Build an actionable error message for LLM self-correction ──
          // Extract the tool name Qwen complained about from the error details
          const toolNameMatch = notExistDetails.match(/(?:Tool|tool|Function|function)\s*['"]([^'"]+)['"]|['"]([^'"]+)['"]\s*(?:does not exist|not exist|is not exist)/i);
          const complainedTool = toolNameMatch?.[1] || toolNameMatch?.[2] || 'unknown';
          const availableToolNames: string[] = (tools as any[] | undefined)
            ?.map((t: any) => t?.function?.name || t?.name)
            .filter((n: string | undefined): n is string => !!n) || [];

          // If the complained tool name IS in our registered tool list, this
          // is a Qwen routing bug — NOT an LLM mistake. Don't blame the LLM;
          // just treat it as a generic upstream error so the retry loop can
          // switch accounts instead of sending Claude Code into a correction loop.
          const complainedLower = complainedTool.toLowerCase().replace(/[-_]/g, '');
          const isActuallyRegistered = availableToolNames.some((n) =>
            n.toLowerCase().replace(/[-_]/g, '') === complainedLower
          );
          if (isActuallyRegistered) {
            logStore.log('warn', 'qwen', `[Qwen] Tool "${complainedTool}" exists but was rejected by upstream — treating as generic error`);
            throw new QwenUpstreamError(
              `Qwen rejected a valid tool call for "${complainedTool}". This may be a Qwen routing issue.`,
              'tool_rejected_by_qwen',
              500,
            );
          }

          // Fuzzy match: find similar available tool names (Levenshtein-like heuristics)
          let suggestion = '';
          if (complainedTool !== 'unknown' && availableToolNames.length > 0) {
            const scored = availableToolNames.map((n) => {
              const clean = n.toLowerCase().replace(/[-_]/g, '');
              // Simple similarity: count common characters in order
              let common = 0; let ci = 0;
              for (let ni = 0; ni < clean.length && ci < complainedLower.length; ni++) {
                if (clean[ni] === complainedLower[ci]) { common++; ci++; }
              }
              const longerLen = Math.max(clean.length, complainedLower.length);
              return { name: n, score: longerLen > 0 ? common / longerLen : 0 };
            });
            const best = scored.sort((a, b) => b.score - a.score).slice(0, 3).filter(s => s.score > 0.4);
            if (best.length > 0) {
              suggestion = `\n\nDid you mean: ${best.map(s => `"${s.name}"`).join(', ')}?`;
            }
          }

          const toolList = availableToolNames.length > 0
            ? `\n\nAvailable tools: [${availableToolNames.join(', ')}]`
            : '';

          throw new QwenToolNotFoundError(
            `Qwen: ${errorJson.data.details}\n\n` +
            `The tool "${complainedTool}" was rejected because it doesn't match any registered tool. ` +
            `This is NOT a system limitation — you likely misspelled or hallucinated the tool name.${suggestion}${toolList}\n\n` +
            `Please retry with the EXACT correct tool name from the available list.`,
            400,
          );
        }
      } catch (parseOrRetryError) {
        if (parseOrRetryError instanceof RetryableQwenStreamError || parseOrRetryError instanceof QwenUpstreamError || parseOrRetryError instanceof QwenToolNotFoundError) {
          throw parseOrRetryError;
        }
      }
    }
    const sanitizedErrText = errText
      .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT_REDACTED]')
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT_REDACTED]')
      .slice(0, 500);
    throw new UpstreamStatusError(
      `Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${sanitizedErrText}`,
      response.status,
    );
  }

  let makeRequestQwenLogFile: string | undefined;
  const makeRequest = async (): Promise<{ response: Response; headers: Record<string, string>; qwenLogFile?: string }> => {
    // Rate-limit per account so 12 accounts on one IP don't burst past Alibaba's
    // WAF threshold (RGV587 "被挤爆"). The 1-3s gap + occasional 2-5s pause is the
    // "human" pacing WAF expects; without it every account hammers concurrently.
    await applyRequestJitter(currentAccountEmail);

    const bodyStr = JSON.stringify(payload);
    if (config.get('SAVE_REQUEST_LOGS') === 'true') {
      makeRequestQwenLogFile = logQwenRequest(payload, url);
    }

    // Wire up the network-debug ring buffer (surfaced at /debug/network) so we
    // can see the upstream HTTP status + chunk stats for any failure, including
    // empty responses. Diagnostic only — a throw here must not break the request.
    try {
      if (currentDebugEntryId) errorEntry(currentDebugEntryId, 'superseded by retry');
      currentDebugEntryId = createNetworkEntry({
        url,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'token=<redacted>', // redacted by networkDebug; actual token never needed for diagnosis
        },
        body: payload,
        category: 'chat',
        accountEmail: currentAccountEmail,
      }).id;
      lastDebugEntryId = currentDebugEntryId;
    } catch (debugErr) {
      console.error('[Qwen] networkDebug create failed (ignored):', (debugErr as Error)?.message);
      currentDebugEntryId = null;
      lastDebugEntryId = null;
    }

    // Browserless path: impers worker for TLS/HTTP2 impersonation, cookie from account manager
    const tokenInfo = currentAccountEmail ? await getTokenWithAccount(currentAccountEmail) : null;
    const cookieStr = tokenInfo ? tokenInfo.cookie : '';
    const tokenPreview = cookieStr ? cookieStr.substring(0, 20) + '...' : 'none';

    logStore.log(
      'debug',
      'qwen',
      `[Qwen] Fetch POST ${url.substring(0, 100)} account=${currentAccountEmail || '?'} token_len=${cookieStr.length} payload_len=${bodyStr.length}`,
    );

    const response = await browserlessFetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        version: '0.2.66', // Qwen SPA version — required or Qwen returns Bad_Request
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: chatId ? `https://chat.qwen.ai/c/${chatId}` : 'https://chat.qwen.ai/',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'x-accel-buffering': 'no',
        'x-request-id': crypto.randomUUID(),
        timezone: cachedTimezone,
      },
      body: bodyStr,
      accountEmail: currentAccountEmail,
      stream: true, // keep session alive for streaming via impers worker
      signal: streamAbortController.signal,
    });
    logStore.log(
      'debug',
      'qwen',
      `[Qwen] Fetch response status=${response.status} ok=${response.ok} account=${currentAccountEmail || '?'} debugId=${currentDebugEntryId || 'null'}`,
    );
    try {
      if (currentDebugEntryId) recordResponse(currentDebugEntryId, response);
      else logStore.log('warn', 'qwen', `[Qwen] recordResponse skipped — no debug entry (account=${currentAccountEmail || '?'})`);
    } catch (debugErr) {
      console.error('[Qwen] networkDebug recordResponse failed (ignored):', (debugErr as Error)?.message);
    }
    // ponytail: when Qwen returns a non-2xx status code with a JSON error body
    // (rate limits, chat-in-progress, tool-not-found, etc.), parse the error
    // and throw a typed RetryableQwenStreamError so the retry loop can switch
    // accounts or retry with backoff. Without this, we'd feed the error JSON
    // as SSE chunks into the streaming pipeline and the client sees garbage.
    if (!response.ok) {
      await handleErrorResponse(response, lastDebugEntryId || '');
    }
    return { response, headers: {}, qwenLogFile: makeRequestQwenLogFile };
  };

  let result: { response: Response; headers: Record<string, string>; qwenLogFile?: string };
  const cbState = qwenCircuitBreaker.getState();
  if (cbState === 'open') {
    const stats = qwenCircuitBreaker.getStats();
    const retryAfterMs = Math.max(0, 30_000 - (Date.now() - stats.lastFailureTime));
    throw new CircuitOpenError(retryAfterMs);
  }
  if (retriesEnabled && retryConfig.maxRetries > 0) {
    result = await withRetry(makeRequest, { ...retryConfig, circuitBreaker: qwenCircuitBreaker });
  } else {
    result = await makeRequest();
    await qwenCircuitBreaker.recordSuccess();
  }
  if (!result.response.body) {
    throw new Error(`Qwen returned empty response body (status ${result.response.status})`);
  }
  const streamDebugEntryId = lastDebugEntryId;
  const textDecoder = new TextDecoder();
  const wreqClose = (result.response as any)._wreqClose as (() => void) | undefined;
  // WAF diag: dump raw upstream response chunks for diagnosis
  let _diagDumped = false;
  const _diagWrite = (chunk: Uint8Array) => {
    if (_diagDumped) return;
    _diagDumped = true;
    try {
      const fs = require('fs');
      const dumpDir = '.qwen/wreq-debug';
      if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]+/g, '-');
      fs.appendFileSync(`${dumpDir}/chat-stream-${ts}.dump`, '[' + chunk.length + ' bytes @ ' + ts + ']\n' + textDecoder.decode(chunk, { stream: true }) + '\n---\n');
    } catch (e) {}
  };
  const wrappedStream = result.response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (streamDebugEntryId) {
          recordStreamChunk(streamDebugEntryId, textDecoder.decode(chunk, { stream: true }));
        }
        if (!_diagDumped) _diagWrite(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (streamDebugEntryId) {
          completeEntry(streamDebugEntryId);
        }
        try {
          wreqClose?.();
          logSessionClose('qwen.stream.flush');
        } catch (closeErr) {
          logCrash('qwen.stream.flush', closeErr, { accountEmail: currentAccountEmail });
        }
      },
    }),
  );
  return {
    stream: wrappedStream,
    headers: result.headers,
    uiSessionId: chatId || '',
    accountEmail: currentAccountEmail,
    abortController: streamAbortController,
    qwenLogFile: result.qwenLogFile,
  };
}
