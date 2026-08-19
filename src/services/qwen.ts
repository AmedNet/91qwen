import crypto from 'node:crypto';
import { CircuitBreaker, CircuitOpenError, withRetry } from '../utils/retry.ts';
import { logCrash, logSessionClose } from '../utils/wreqCrashLogger.ts';
import { getTokenWithAccount, pickAccount, setAccountDisabled, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { completeEntry, createNetworkEntry, errorEntry, recordResponse, recordStreamChunk } from './networkDebug.ts';
import { logQwenRequest, logQwenResponse, logQwenSSE } from './qwenLogger.ts';

export { configureAccount, deleteAllChats, fetchQwenModels } from './qwenModels.ts';

// Shared URL constants for Qwen API
export const QWEN_API_BASE = 'https://chat.qwen.ai';
export const QWEN_CHAT_COMPLETIONS_URL = `${QWEN_API_BASE}/api/v2/chat/completions`;
export const QWEN_SETTINGS_URL = `${QWEN_API_BASE}/api/v2/users/user/settings/update`;

export type ThinkingFormat = 'summary' | 'full';

/** Build shared feature_config for Qwen message payloads. */
export function buildFeatureConfig(enableThinking: boolean, thinkingFormat: ThinkingFormat = 'summary'): Record<string, any> {
  return {
    thinking_enabled: enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: false,
    thinking_mode: 'Thinking',
    thinking_format: thinkingFormat,
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

/**
 * Thrown after an interactive CAPTCHA solve succeeded — the caller must retry
 * on the SAME account (throttle was already cleared by saveCookies) instead of
 * throttling it and rotating to the next account.
 */
export class CaptchaSolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaSolvedError';
  }
}

/**
 * Thrown when Qwen returns a CAPTCHA challenge. The caller MUST surface this
 * to the downstream client as a 5xx error so the client (Codex CLI etc.) can
 * apply its own retry / backoff policy. We deliberately do NOT pop a visible
 * browser window here — that adds a 2-minute synchronous wait per failed
 * request and balloons latency. Instead we throttle the account and bail.
 */
export class CaptchaRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaRequiredError';
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

/** Compose multiple AbortSignals into one — fires when any input fires. */
function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  const composed = new AbortController();
  const onAbort = () => composed.abort();
  for (const s of valid) {
    if (s.aborted) {
      composed.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return composed.signal;
}

// Cached timezone for request headers
const cachedTimezone = 'America/Sao_Paulo';

export function createFetchTimeout(): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = config.getInt('QWEN_FETCH_TIMEOUT_MS', 30000);
  if (timeout > 0) {
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeout);
    return { controller, cleanup: () => clearTimeout(timer) };
  }
  return { controller, cleanup: () => {} };
}

// NOTE: buildRequestHeaders() and applyRequestJitter() were removed — they
// were dead code (never called; makeRequest builds its own headers inline).
// If inter-request jitter is ever needed again, wire it into createQwenStream
// explicitly rather than leaving an unwired helper.

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
    // Do NOT inject top-level tools/tool_choice — that triggers OpenAI
    // compatibility mode which silently downgrades thinking_format to summary.
    // local_mcp is already populated in chatHelpers.ts when body.tools exist.
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
  const streamAbortController = new AbortController();

  async function handleErrorResponse(response: Response, debugEntryId: string): Promise<never> {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        if (errorJson?.data?.details?.includes('chat is in progress') || errorJson?.data?.details?.includes('The chat is in progress')) {
          // 上游会话仍在处理中（通常是上一个请求超时/中断后在上游残留）。
          // 冷却该账号，避免后续请求在会话释放前再次打到同一账号。
          if (currentAccountEmail) {
            throttleAccount(currentAccountEmail, 30_000);
          }
          errorEntry(debugEntryId, errorJson.data.details);
          logStore.log('warn', 'qwen', `Chat in progress for ${currentAccountEmail} — throttled 30s`);
          throw new QwenUpstreamError(`Qwen: ${errorJson.data.details}`, 'ChatInProgress', 409);
        }

        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined ? ` Wait about ${errorJson.data.num} hour(s) before trying again.` : '';
          if (code === 'RateLimited' && currentAccountEmail) {
            const throttleMs = (errorJson.data?.num || 1) * 3600_000;
            throttleAccount(currentAccountEmail, throttleMs);
            const detailsLower = (details || '').toLowerCase();
            if (detailsLower.includes('upper limit for today') || detailsLower.includes('reached the upper limit')) {
              logStore.log(
                'warn',
                'qwen',
                `[Qwen] DAILY LIMIT: ${currentAccountEmail} reached daily usage upper limit — disabling account`,
              );
              setAccountDisabled(currentAccountEmail, true);
            }
            const nextAccount = await pickAccount(currentAccountEmail);
            if (nextAccount) {
              currentAccountEmail = nextAccount.email;
              // Do NOT decrementInFlight here: pickAccount already incremented
              // the slot for the new account. Releasing it immediately would let
              // concurrent requests pick the same account and trigger upstream
              // "chat is in progress". The slot is released by the normal
              // request-end release path.
            } else {
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

        // Qwen anti-bot CAPTCHA — never pop a visible browser here. The
        // interactive solver used to add a 2-minute synchronous wait per
        // failed request, which destroys latency. Instead, throttle the
        // account, log loudly, and surface the failure to the downstream
        // client so it can apply its own retry policy.
        if (errorJson?.ret?.[0] === 'FAIL_SYS_USER_VALIDATE') {
          const details = errorJson.ret[1] || 'CAPTCHA required';
          logStore.log('warn', 'qwen', `CAPTCHA detected for ${currentAccountEmail || 'unknown'}: ${details}`);

          if (currentAccountEmail) {
            throttleAccount(currentAccountEmail, 5 * 60 * 1000);
            logStore.log(
              'debug',
              'qwen',
              `[Qwen] BOT DETECTION: ${currentAccountEmail} hit FAIL_SYS_USER_VALIDATE — throttled 5min, surfacing to client`,
            );
          }
          errorEntry(debugEntryId, `CAPTCHA required: ${details}`);
          throw new CaptchaRequiredError(`Qwen CAPTCHA — ${details}`);
        }

        if (
          errorJson?.data?.details?.includes('is not exist') ||
          errorJson?.data?.details?.includes('not exist') ||
          errorJson?.data?.details?.includes('does not exist')
        ) {
          errorEntry(debugEntryId, errorJson.data.details);
          throw new RetryableQwenStreamError(`Qwen: ${errorJson.data.details}`, 0);
        }
      } catch (parseOrRetryError) {
        if (
          parseOrRetryError instanceof RetryableQwenStreamError ||
          parseOrRetryError instanceof QwenUpstreamError ||
          parseOrRetryError instanceof CaptchaSolvedError ||
          // Must be rethrown: callers rely on `instanceof CaptchaRequiredError`
          // to surface CAPTCHA failures to the downstream client. Swallowing it
          // here would downgrade it to a generic UpstreamStatusError below.
          parseOrRetryError instanceof CaptchaRequiredError
        ) {
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
  let qwenResponseStatus = 0;
  let qwenResponseStatusText = '';
  let qwenResponseHeaders: Record<string, string> = {};
  let qwenResponsePreview = '';
  let sseEventCount = 0;
  const makeRequest = async (
    attemptSignal?: AbortSignal,
  ): Promise<{ response: Response; headers: Record<string, string>; qwenLogFile?: string }> => {
    const bodyStr = JSON.stringify(payload);
    if (config.get('SAVE_REQUEST_LOGS') === 'true') {
      makeRequestQwenLogFile = logQwenRequest(payload, url);
    }

    // Browserless path: impers worker for TLS/HTTP2 impersonation, cookie from account manager
    const tokenInfo = currentAccountEmail ? await getTokenWithAccount(currentAccountEmail) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

    logStore.log(
      'debug',
      'qwen',
      `[Qwen] Fetch POST ${url.substring(0, 100)} account=${currentAccountEmail || '?'} token_len=${cookieStr.length} payload_len=${bodyStr.length}`,
    );

    // ── Network debug instrumentation ────────────────────────────
    // Previously lastDebugEntryId was never assigned, so recordStreamChunk /
    // completeEntry below were silent no-ops and the dashboard Network page
    // showed no Qwen upstream traffic. Create one entry per attempt.
    try {
      const debugEntry = createNetworkEntry({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieStr },
        body: payload,
        category: 'chat',
        accountEmail: currentAccountEmail,
      });
      lastDebugEntryId = debugEntry.id;
    } catch {
      /* debug instrumentation is best-effort */
    }

    // ── TTFB instrumentation ─────────────────────────────────────
    const tFetchStart = Date.now();

    // Compose streamAbortController.signal (created at function entry for client cancel) with the
    // per-attempt signal (from withRetry's attemptTimeoutMs). Either source aborts the fetch.
    const composedSignal = attemptSignal ? composeAbortSignals(streamAbortController.signal, attemptSignal) : streamAbortController.signal;

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
      transport: config.getBool('FAST_TRANSPORT', true) ? 'plain' : 'wreq',
      signal: composedSignal,
    });
    if (lastDebugEntryId) recordResponse(lastDebugEntryId, response);
    logStore.log(
      'debug',
      'qwen',
      `[Qwen] Fetch response status=${response.status} ok=${response.ok} account=${currentAccountEmail || '?'}`,
    );
    logStore.log(
      'debug',
      'qwen-timing',
      `TTFB=${Date.now() - tFetchStart}ms (acct=${currentAccountEmail?.split('@')[0] || '?'}, payload=${bodyStr.length}B)`,
    );

    if (config.get('SAVE_REQUEST_LOGS') === 'true') {
      qwenResponseStatus = response.status;
      qwenResponseStatusText = response.statusText;
      response.headers.forEach((value, key) => {
        qwenResponseHeaders[key] = value;
      });

      // DO NOT await the full body here — for streaming chat completions the body stays
      // open until the upstream SSE finishes, which can take 30s+. Awaiting it inside
      // makeRequest would (a) trip withRetry's attemptTimeoutMs and (b) prevent the
      // attempt from returning its Response so the SSE pipe-through can start.
      // Instead, log what we already have synchronously, then drain the body in the
      // background and persist the preview when it completes. If the user disables
      // SAVE_REQUEST_LOGS, no body read happens at all.
      logQwenResponse(makeRequestQwenLogFile || '', response.status, response.statusText, qwenResponseHeaders, qwenResponsePreview);
      const qwenLogFileForBg = makeRequestQwenLogFile;
      const statusForBg = response.status;
      const statusTextForBg = response.statusText;
      const headersForBg = { ...qwenResponseHeaders };
      if (qwenLogFileForBg) {
        (async () => {
          try {
            const clone = response.clone();
            const text = await clone.text();
            const preview = text.substring(0, 10000);
            logQwenResponse(qwenLogFileForBg, statusForBg, statusTextForBg, headersForBg, preview);
          } catch (err) {
            logStore.log('warn', 'qwen', `[Qwen] Failed background body read for logging: ${(err as Error).message}`);
          }
        })();
      }
    }

    // Wire attempt-scoped cleanup: when this attempt is aborted (timeout / client cancel /
    // next-retry cleanup), cancel the upstream response body so the server-side chat_id is
    // released. Otherwise an aborted SSE keeps the chat_id locked and the next attempt on
    // the same chat_id immediately returns "The chat is in progress!".
    let cleanedUp = false;
    const cleanupAttempt = (reason: string) => {
      if (cleanedUp) return;
      cleanedUp = true;
      const body = response.body;
      if (body && typeof body.cancel === 'function') {
        body.cancel().catch(() => {});
      }
      // Also close the transport session directly: when the body is cancelled
      // the downstream pipeThrough cancel hook may not fire (e.g. consumer
      // never attached). _wreqClose implementations are idempotent no-ops or
      // safe to call twice with the wrappedStream cancel path.
      const wc = (response as any)._wreqClose;
      if (typeof wc === 'function') {
        try {
          wc();
        } catch {
          /* best-effort */
        }
      }
      logStore.log(
        'debug',
        'qwen',
        `[Qwen] Attempt cleaned up (${reason}) for ${currentAccountEmail || '?'} — body cancelled to release chat_id`,
      );
    };
    if (attemptSignal) {
      if (attemptSignal.aborted) cleanupAttempt('attemptSignal already aborted on response');
      else attemptSignal.addEventListener('abort', () => cleanupAttempt('attemptSignal abort'), { once: true });
    }
    if (streamAbortController.signal.aborted) cleanupAttempt('streamAbortController already aborted on response');
    else streamAbortController.signal.addEventListener('abort', () => cleanupAttempt('streamAbortController abort'), { once: true });

    return { response, headers: {}, qwenLogFile: makeRequestQwenLogFile, cleanup: cleanupAttempt } as {
      response: Response;
      headers: Record<string, string>;
      qwenLogFile?: string;
      cleanup: () => void;
    };
  };

  let result: { response: Response; headers: Record<string, string>; qwenLogFile?: string; cleanup?: () => void };
  const cbState = qwenCircuitBreaker.getState();
  if (cbState === 'open') {
    const stats = qwenCircuitBreaker.getStats();
    const retryAfterMs = Math.max(0, 30_000 - (Date.now() - stats.lastFailureTime));
    throw new CircuitOpenError(retryAfterMs);
  }
  if (retriesEnabled && retryConfig.maxRetries > 0) {
    // withRetry 现在为每个 attempt 创建独立 controller 并在 attemptTimeoutMs 时 abort 它。
    // onAttemptDiscarded 钩子确保 abort 之前的 attempt 时主动 cancel 上游 response.body，
    // 让上游释放 chat_id（否则 abort 不会关闭 SSE 流，下个 attempt 用同 chat_id
    // 立刻返回 "The chat is in progress!"）。
    try {
      result = await withRetry(makeRequest, {
        ...retryConfig,
        circuitBreaker: qwenCircuitBreaker,
        onAttemptDiscarded: (discardedResult) => {
          const r = discardedResult as { cleanup?: () => void } | null;
          if (r && typeof r.cleanup === 'function') {
            try {
              r.cleanup();
            } catch (e) {
              logStore.log('warn', 'qwen', `[Qwen] attempt cleanup threw: ${(e as Error).message}`);
            }
          }
        },
      });
    } catch (err) {
      streamAbortController.abort();
      throw err;
    }
  } else {
    result = await makeRequest();
    await qwenCircuitBreaker.recordSuccess();
  }
  if (!result.response.body) {
    throw new Error(`Qwen returned empty response body (status ${result.response.status})`);
  }

  // Qwen may answer an ERROR with HTTP 200 + a JSON body (anti-bot CAPTCHA
  // FAIL_SYS_USER_VALIDATE, session invalidations, etc.) instead of an SSE
  // stream. Previously this passed straight into the SSE reader which saw no
  // "data:" lines and produced an EMPTY response → Claude Code churned with
  // "no content" while the account was actually being captcha'd. Detect JSON
  // bodies here and route them through handleErrorResponse (throttle+switch).
  const respContentType = result.response.headers.get('content-type') || '';
  if (respContentType.includes('application/json') && !respContentType.includes('text/event-stream')) {
    await handleErrorResponse(result.response, lastDebugEntryId ?? '');
  }

  const streamDebugEntryId = lastDebugEntryId;
  const textDecoder = new TextDecoder();
  const wreqClose = (result.response as any)._wreqClose as (() => void) | undefined;
  // Idempotent close guard: flush() only runs when the stream is fully
  // consumed; on downstream cancel/abort we close via the transformer's
  // cancel() hook, and attempt-cleanup may also fire — never double-close.
  let wreqClosed = false;
  const closeWreqOnce = () => {
    if (wreqClosed) return;
    wreqClosed = true;
    try {
      wreqClose?.();
    } catch (closeErr) {
      logCrash('qwen.stream.close', closeErr, { accountEmail: currentAccountEmail });
    }
  };

  // ── SSE timing instrumentation ────────────────────────────────
  // Diagnostic: log first-byte latency, gaps between SSE events, and
  // classify each event (real content vs keep_alive vs empty think delta).
  // These logs surface where the slowness actually lives — gateway vs
  // upstream — when a request stalls for minutes.
  const sseStartMs = Date.now();
  let sseBuffer = '';
  let lastEventMs = sseStartMs;
  let firstContentMs = 0;
  let firstKeepAliveMs = 0;
  let lastGapWarnMs = 0;
  let sseEvents = { total: 0, keepAlive: 0, think: 0, content: 0, other: 0 };

  const classifySseEvent = (data: string): 'keepAlive' | 'think' | 'content' | 'other' => {
    if (!data) return 'other';
    if (data.includes('"action": "keep_alive"')) return 'keepAlive';
    if (data.includes('"phase": "think"') || data.includes('"phase":"think"')) return 'think';
    if (data.includes('"phase": "finished"') || data.includes('"phase":"finished"') || data.includes('"finish_reason"')) return 'content';
    if (data.includes('"response.created"') || data.includes('"usage"')) return 'other';
    return 'other';
  };

  const wrappedStream = result.response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
        // Decode ONCE per chunk: TextDecoder in { stream: true } mode is
        // stateful — decoding the same bytes twice would corrupt multi-byte
        // characters split across chunk boundaries.
        const decoded = textDecoder.decode(chunk, { stream: true });
        if (streamDebugEntryId) {
          recordStreamChunk(streamDebugEntryId, decoded);
        }
        // SSE event-boundary timing. Each `data: ...\n\n` block is one event.
        sseBuffer += decoded;
        let nlIdx: number;
        while ((nlIdx = sseBuffer.indexOf('\n\n')) !== -1) {
          const block = sseBuffer.slice(0, nlIdx);
          sseBuffer = sseBuffer.slice(nlIdx + 2);
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const data = dataLine.slice(6);
          const kind = classifySseEvent(data);
          sseEvents[kind]++;
          sseEvents.total++;
          const now = Date.now();
          const gap = now - lastEventMs;
          if (kind === 'keepAlive') {
            if (firstKeepAliveMs === 0) firstKeepAliveMs = now - sseStartMs;
          }
          if (kind === 'content' && firstContentMs === 0) {
            firstContentMs = now - sseStartMs;
            logStore.log(
              'debug',
              'qwen-timing',
              `first real content after ${firstContentMs}ms (acct=${currentAccountEmail?.split('@')[0] || '?'})`,
            );
          }
          // Warn on gaps > 5s — the upstream is stalling
          if (gap > 5000 && sseEvents.total > 1) {
            if (now - lastGapWarnMs > 30000) {
              logStore.log(
                'warn',
                'qwen-timing',
                `SSE gap ${gap}ms (kind=${kind}, event#${sseEvents.total}, acct=${currentAccountEmail?.split('@')[0] || '?'}, elapsed=${now - sseStartMs}ms)`,
              );
              lastGapWarnMs = now;
            }
          }
          lastEventMs = now;
        }
        if (config.get('SAVE_REQUEST_LOGS') === 'true') {
          sseEventCount++;
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (streamDebugEntryId) {
          completeEntry(streamDebugEntryId);
        }
        const totalMs = Date.now() - sseStartMs;
        logStore.log(
          'debug',
          'qwen-timing',
          `stream done total=${totalMs}ms firstKeepAlive=${firstKeepAliveMs}ms firstContent=${firstContentMs}ms events=${JSON.stringify(sseEvents)} (acct=${currentAccountEmail?.split('@')[0] || '?'})`,
        );
        if (config.get('SAVE_REQUEST_LOGS') === 'true' && makeRequestQwenLogFile) {
          logQwenSSE(makeRequestQwenLogFile, sseEventCount, 0, []);
        }
        try {
          closeWreqOnce();
          logSessionClose('qwen.stream.flush');
        } catch (closeErr) {
          logCrash('qwen.stream.flush', closeErr, { accountEmail: currentAccountEmail });
        }
      },
      cancel() {
        // Downstream consumer cancelled/aborted — flush() does NOT run in
        // this case, so close the transport session here to avoid leaking
        // wreq sessions (previously wreqClose was only called from flush()).
        try {
          closeWreqOnce();
          logSessionClose('qwen.stream.cancel');
        } catch (closeErr) {
          logCrash('qwen.stream.cancel', closeErr, { accountEmail: currentAccountEmail });
        }
      },
      // The WHATWG streams spec permits an optional cancel() on transformers,
      // but the bundled TS `Transformer` type omits it — cast the object so
      // the cancel hook still registers at runtime (Bun supports it).
    } as unknown as Transformer<Uint8Array, Uint8Array>),
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
