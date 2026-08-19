import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';

/**
 * Retry utility with configurable max attempts, exponential backoff,
 * per-attempt timeout, and circuit breaker pattern.
 * Only retries on transient errors (network, 5xx, 429).
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 500) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 10000) */
  maxDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
  /** List of HTTP status codes that should NOT be retried (4xx except 429) */
  nonRetryableStatuses?: number[];
  /** Per-attempt timeout in ms (default: 30000 = 30s). 0 = no timeout. */
  attemptTimeoutMs?: number;
  /** Circuit breaker instance to use (optional). If provided, open circuit = immediate rejection. */
  circuitBreaker?: CircuitBreaker;
  /**
   * Called whenever an attempt is discarded (failure, timeout, or abort). The discarded
   * attempt's result is passed in — note it is `undefined` when the attempt never
   * completed (the timeout/abort case), so handlers must tolerate that. Callers use it
   * to clean up attempt-scoped resources — typically cancelling an upstream Response.body
   * so the upstream chat_id is released before the next attempt reuses it. Without this,
   * an aborted SSE stream keeps the chat_id locked and the next attempt hits
   * "The chat is in progress!".
   */
  onAttemptDiscarded?: (result: unknown, error: unknown) => void;
}

function getDefaultRetryConfig(): Required<Omit<RetryConfig, 'onAttemptDiscarded'>> & {
  onAttemptDiscarded?: (result: unknown, error: unknown) => void;
} {
  return {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    nonRetryableStatuses: [400, 401, 403, 404, 405, 409, 410, 411, 412, 413, 414, 415, 418],
    attemptTimeoutMs: 30000,
    circuitBreaker: undefined as never,
  };
}

const DEFAULT_CONFIG: Required<Omit<RetryConfig, 'onAttemptDiscarded'>> & {
  onAttemptDiscarded?: (result: unknown, error: unknown) => void;
} = getDefaultRetryConfig();

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Circuit breaker is open. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Attempt timed out after ${timeoutMs}ms`);
    this.name = 'AttemptTimeoutError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms before transitioning from open to half-open (default: 30000) */
  resetTimeoutMs?: number;
  /** Number of successes in half-open state to close the circuit (default: 1) */
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  readonly name: string;
  /** Promise-chain mutex to prevent concurrent recordSuccess/recordFailure races */
  private lock: Promise<void> = Promise.resolve();

  constructor(name: string, config?: CircuitBreakerConfig) {
    this.name = name;
    this.failureThreshold = config?.failureThreshold ?? 5;
    this.resetTimeoutMs = config?.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = config?.halfOpenMaxAttempts ?? 1;
  }

  getResetTimeoutMs(): number {
    return this.resetTimeoutMs;
  }

  tryTransitionToHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.successCount = 0;
      console.error(`[CircuitBreaker:${this.name}] open → half_open (reset timeout elapsed)`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): { state: CircuitState; failureCount: number; successCount: number; lastFailureTime: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Check if the circuit allows a request to pass. Throws CircuitOpenError if open.
   *
   * Note: this path (via tryTransitionToHalfOpen) mutates state outside the
   * recordSuccess/recordFailure mutex. That is safe because it executes fully
   * synchronously — in a single-threaded event loop no interleaving can occur
   * within one call. The mutex exists only to serialize the async record*()
   * promise chains against each other.
   */
  allowRequest(): void {
    this.tryTransitionToHalfOpen();
    if (this.state === 'open') {
      const retryAfterMs = Math.max(0, this.resetTimeoutMs - (Date.now() - this.lastFailureTime));
      throw new CircuitOpenError(retryAfterMs);
    }
  }

  /** Record a successful execution. */
  recordSuccess(): Promise<void> {
    return new Promise((resolve) => {
      this.lock = this.lock
        .then(() => {
          if (this.state === 'half_open') {
            this.successCount++;
            if (this.successCount >= this.halfOpenMaxAttempts) {
              this.state = 'closed';
              this.failureCount = 0;
            }
          } else {
            this.failureCount = 0;
          }
          resolve();
        })
        .catch((err) => {
          console.error(`[CircuitBreaker:${this.name}] mutex error in recordSuccess:`, err);
          resolve();
        });
    });
  }

  /** Record a failed execution. */
  recordFailure(): Promise<void> {
    return new Promise((resolve) => {
      this.lock = this.lock
        .then(() => {
          this.lastFailureTime = Date.now();
          if (this.state === 'half_open') {
            this.state = 'open';
            console.error(`[CircuitBreaker:${this.name}] half_open → open (probe failed)`);
          } else {
            this.failureCount++;
            if (this.failureCount >= this.failureThreshold) {
              this.state = 'open';
              logStore.log('debug', 'retry', `[CircuitBreaker:${this.name}] closed → open (${this.failureCount} consecutive failures)`);
            }
          }
          resolve();
        })
        .catch((err) => {
          console.error(`[CircuitBreaker:${this.name}] mutex error in recordFailure:`, err);
          resolve();
        });
    });
  }

  /** Force reset to closed state (useful for manual intervention). */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /** Wrap an async function with circuit breaker protection. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.allowRequest();
    try {
      const result = await fn();
      await this.recordSuccess();
      return result;
    } catch (error) {
      if (isRetryable(error)) {
        await this.recordFailure();
      }
      throw error;
    }
  }
}

/**
 * Determines if an error or HTTP status is retryable.
 * Retryable: network errors, timeout, 429, 500, 502, 503, 504
 * Non-retryable: 4xx except 429, or explicit NonRetryableError
 */
export function isRetryable(error: unknown, httpStatus?: number): boolean {
  // Explicit non-retryable
  if (error instanceof NonRetryableError) return false;

  // An AbortError means an EXTERNAL abort (client disconnect / caller
  // cancelled the request). Our own per-attempt timeout rejects with
  // AttemptTimeoutError instead — so an AbortError reaching this point means
  // the requester is already gone and retrying upstream is wasted work.
  if (error instanceof Error && error.name === 'AbortError') return false;

  // Network errors (fetch throws TypeError/DOMException for network issues).
  // NOTE: 'aborted' is deliberately NOT a keyword — abort messages are
  // handled by the AbortError check above and must not be retried.
  if (error instanceof TypeError || error instanceof DOMException) {
    const msg = String(error.message).toLowerCase();
    const networkKeywords = ['network', 'fetch', 'timeout', 'connection', 'econnrefused', 'enotfound', 'econnreset', 'socket'];
    return networkKeywords.some((kw) => msg.includes(kw));
  }

  // Timeout
  if (error instanceof AttemptTimeoutError) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  // HTTP status check
  if (httpStatus !== undefined) {
    if (httpStatus === 429) return true; // rate limited
    if (httpStatus >= 500) return true; // server error
    if (httpStatus >= 400 && httpStatus < 500) {
      // 4xx are generally non-retryable (except 429 handled above)
      return false;
    }
  }

  // Generic error messages from upstream that indicate transient issues
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('enomem') ||
      msg.includes('eai_fail') ||
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('upstream') ||
      msg.includes('server error') ||
      msg.includes('bad gateway') ||
      msg.includes('service unavailable') ||
      msg.includes('gateway timeout') ||
      msg.includes('internal server error')
    ) {
      return true;
    }
  }

  // Unknown error — don't retry by default
  return false;
}

/**
 * Sleep for the specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal, abortController?: AbortController): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Prefer caller-provided AbortController (it has .abort() reliably); fall back to
      // duck-typing the signal in case caller passes one. In some runtimes AbortSignal
      // exposes an .abort() (e.g. Bun), in others it doesn't — the controller path always
      // works because we create it ourselves in withRetry.
      if (abortController && !abortController.signal.aborted) {
        try {
          abortController.abort(new Error(`Attempt timed out after ${timeoutMs}ms`));
        } catch {
          /* ignore */
        }
      } else if (signal && !signal.aborted) {
        try {
          (signal as unknown as { abort?: (reason?: unknown) => void }).abort?.(new Error(`Attempt timed out after ${timeoutMs}ms`));
        } catch {
          /* ignore */
        }
      }
      reject(new AttemptTimeoutError(timeoutMs));
    }, timeoutMs);
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Load retry config from environment variables with defaults.
 */
export function getRetryConfigFromEnv(): Required<Omit<RetryConfig, 'onAttemptDiscarded'>> {
  const envConfig: RetryConfig = {};

  envConfig.maxRetries = Math.max(0, config.getInt('RETRY_MAX_ATTEMPTS', DEFAULT_CONFIG.maxRetries));
  envConfig.baseDelayMs = Math.max(0, config.getInt('RETRY_BASE_DELAY_MS', DEFAULT_CONFIG.baseDelayMs));
  envConfig.maxDelayMs = Math.max(0, config.getInt('RETRY_MAX_DELAY_MS', DEFAULT_CONFIG.maxDelayMs));
  envConfig.backoffMultiplier = Math.max(0.1, config.getFloat('RETRY_BACKOFF_MULTIPLIER', DEFAULT_CONFIG.backoffMultiplier));

  return { ...DEFAULT_CONFIG, ...envConfig };
}

export async function withRetry<T>(fn: (attemptSignal: AbortSignal) => Promise<T>, config?: RetryConfig): Promise<T> {
  const cfg: Required<Omit<RetryConfig, 'onAttemptDiscarded'>> & { onAttemptDiscarded?: (result: unknown, error: unknown) => void } = {
    ...DEFAULT_CONFIG,
    ...getRetryConfigFromEnv(),
    ...config,
  };

  if (cfg.circuitBreaker) {
    cfg.circuitBreaker.allowRequest();
  }

  let lastError: unknown;
  let delay = cfg.baseDelayMs;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    // 每个 attempt 一个独立 controller：超时主动 abort 让上游连接真正关闭，
    // 避免下个 attempt 用同一个 chatId 时撞上"chat is in progress"
    const attemptController = new AbortController();
    let attemptResult: unknown;
    try {
      attemptResult = await withTimeout(fn(attemptController.signal), cfg.attemptTimeoutMs, attemptController.signal, attemptController);
      if (cfg.circuitBreaker) await cfg.circuitBreaker.recordSuccess();
      return attemptResult as T;
    } catch (error: unknown) {
      // Attempt failed — always notify the discard hook. The previous
      // `attemptResult !== undefined` guard made this hook unreachable in the
      // exact scenario it exists for: on timeout/abort the await above never
      // assigns attemptResult, so the cleanup callback never fired and the
      // aborted SSE kept the upstream chat_id locked. The hook now fires on
      // every discarded attempt (result is undefined when fn never completed);
      // handlers must tolerate an undefined result.
      if (cfg.onAttemptDiscarded) {
        try {
          cfg.onAttemptDiscarded(attemptResult, error);
        } catch (cleanupErr) {
          // cleanup failures must not mask the original error
          console.error('[Retry] onAttemptDiscarded cleanup threw:', cleanupErr);
        }
      }
      attemptResult = undefined;
      lastError = error;

      // Extract a structured HTTP status only from typed error fields
      // (.status / .statusCode / .upstreamStatus). The previous regex scan of
      // error.message matched ANY three-digit number — e.g. "payload exceeds
      // 500 bytes" was misread as HTTP 500 and triggered bogus retries.
      let httpStatus: number | undefined;
      if (error && typeof error === 'object') {
        const errObj = error as Record<string, unknown>;
        const candidate = errObj.status ?? errObj.statusCode ?? errObj.upstreamStatus;
        if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) {
          httpStatus = candidate;
        }
      }

      let retryable = isRetryable(error, httpStatus);
      // Honor the configured non-retryable status list (previously declared
      // with a default value but never read — dead config).
      if (retryable && httpStatus !== undefined && cfg.nonRetryableStatuses.includes(httpStatus)) {
        retryable = false;
      }

      if (cfg.circuitBreaker && retryable) {
        await cfg.circuitBreaker.recordFailure();
      }

      if (!retryable || attempt >= cfg.maxRetries) {
        throw error;
      }

      if (cfg.circuitBreaker && cfg.circuitBreaker.getState() === 'open') {
        const stats = cfg.circuitBreaker.getStats();
        const resetTimeoutMs = cfg.circuitBreaker.getResetTimeoutMs();
        const retryAfterMs = Math.max(0, stats.lastFailureTime + resetTimeoutMs - Date.now());
        throw new CircuitOpenError(retryAfterMs);
      }

      const jitter = delay * 0.2 * (Math.random() * 2 - 1);
      const actualDelay = Math.min(delay + jitter, cfg.maxDelayMs);

      const errorName = error instanceof Error ? error.name : typeof error;
      const errorMsg = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      logStore.log(
        'debug',
        'retry',
        `[Retry] attempt ${attempt + 1}/${cfg.maxRetries + 1} failed (${httpStatus || errorName}: ${errorMsg}), retrying in ${Math.round(actualDelay)}ms...`,
      );
      await sleep(actualDelay);

      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelayMs);
    }
  }

  throw lastError;
}
