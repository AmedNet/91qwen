import { decrementInFlight, getAccountByEmail, getAllAccountEmails, incrementTotalRequests, pickAccount, throttleAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { logStore } from './logStore.ts';
import { type BasicHeaders, getBasicHeaders } from './playwright.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface PoolEntry {
  chatId: string;
  parentId: string | null;
  inUse: boolean;
  cachedHeaders?: { cookie: string; userAgent: string };
  /** Which account email this session is bound to */
  accountEmail?: string;
}

interface PoolSlot {
  chatId: string;
  accountEmail: string;
  createdAt: number;
}

interface AccountPool {
  slots: PoolSlot[];
  toppingUp: boolean;
}

export function formatQwenEnvelopeError(json: any): string {
  const code = json?.data?.code || json?.code || 'unknown';
  const details = json?.data?.details || json?.details || json?.message || '';
  return details ? `${code}: ${details}` : String(code);
}

export class SessionPool {
  private activeSessions = new Set<string>();
  private activeCount = 0;
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-account pools of pre-created EMPTY chats, so acquire doesn't wait on chats/new. */
  private pools = new Map<string, AccountPool>();
  /** Timestamp (ms) when each active chatId was acquired — used by the stuck sweeper. */
  private acquiredAt = new Map<string, number>();
  /** Tracks cached headers per chatId so sweeper can call deleteSession after release. */
  private cachedByChat = new Map<string, { headers?: { cookie: string; userAgent: string }; email?: string }>();
  /** Background sweeper handle; null until initialize() starts it. */
  private sweeperInterval: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      return;
    }
    // Start stuck-session sweeper unconditionally — it's the belt-and-suspenders
    // backstop that fires even when the chat pool is disabled.
    this.startSweeper();
    const target = this.poolTarget();
    if (target <= 0) return;
    for (const email of getAllAccountEmails()) {
      this.topUp(email).catch(() => {
        /* retried on next acquire */
      });
    }
  }

  private activeTimeoutMs(): number {
    return Math.max(60_000, config.getInt('SESSION_ACTIVE_TIMEOUT_MS', 1_800_000));
  }

  private sweeperIntervalMs(): number {
    return Math.max(10_000, config.getInt('SESSION_SWEEPER_INTERVAL_MS', 300_000));
  }

  /** Start the stuck-session sweeper interval. Idempotent — clears any existing handle first. */
  private startSweeper(): void {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
    const interval = this.sweeperIntervalMs();
    this.sweeperInterval = setInterval(() => {
      try {
        const { swept } = this.sweepStuckSessions();
        if (swept.length > 0) {
          logStore.log(
            'warn',
            'pool',
            `Sweeper released ${swept.length} stuck session(s): ${swept.map((c) => c.substring(0, 8)).join(', ')}`,
          );
        }
      } catch (err: any) {
        logStore.log('debug', 'pool', `Sweeper error: ${err.message}`);
      }
    }, interval);
    if (typeof this.sweeperInterval.unref === 'function') this.sweeperInterval.unref();
  }

  /**
   * Release sessions older than `activeTimeoutMs`. Returns the released chatIds so
   * callers / logs can attribute what was swept. Safe to call concurrently with
   * normal acquire/release — releases through the same idempotent path.
   */
  sweepStuckSessions(): { swept: string[] } {
    const now = Date.now();
    const threshold = this.activeTimeoutMs();
    const swept: string[] = [];
    for (const chatId of this.activeSessions) {
      const acquiredAt = this.acquiredAt.get(chatId) ?? 0;
      if (now - acquiredAt > threshold) {
        const meta = this.cachedByChat.get(chatId);
        swept.push(chatId);
        // Reuse release() — it is idempotent and will schedule DELETE upstream
        // (and clear our bookkeeping), so we don't duplicate cleanup logic.
        void this.release(chatId, null, meta?.headers, meta?.email, false);
      }
    }
    return { swept };
  }

  private poolTarget(): number {
    return Math.max(0, config.getInt('SESSION_POOL_SIZE', 2));
  }

  private poolIdleTtl(): number {
    return Math.max(60_000, config.getInt('SESSION_POOL_IDLE_TTL_MS', 600_000));
  }

  private poolFor(email: string): AccountPool {
    let p = this.pools.get(email);
    if (!p) {
      p = { slots: [], toppingUp: false };
      this.pools.set(email, p);
    }
    return p;
  }

  /** Background top-up: keep up to SESSION_POOL_SIZE empty chats per account. */
  private async topUp(email: string | undefined): Promise<void> {
    const key = email || 'default';
    const target = this.poolTarget();
    if (target <= 0) return;
    const p = this.poolFor(key);
    if (p.toppingUp) return;
    p.toppingUp = true;
    try {
      let guard = 0;
      while (p.slots.length < target && guard++ < 20) {
        try {
          const headers = await getBasicHeaders(email);
          const chatId = await this.createSessionWithHeaders(email, headers);
          p.slots.push({ chatId, accountEmail: key, createdAt: Date.now() });
        } catch (err: any) {
          logStore.log('warn', 'pool', `Pool top-up failed for ${key.split('@')[0]}: ${err.message}`);
          break;
        }
      }
    } finally {
      p.toppingUp = false;
    }
  }

  /** Pop a ready empty chat for the account, dropping stale slots. Returns null if none. */
  private popPooledChat(email: string): string | null {
    const p = this.pools.get(email);
    if (!p) return null;
    if (p.slots.length === 0) return null;
    const now = Date.now();
    const ttl = this.poolIdleTtl();
    const fresh: PoolSlot[] = [];
    for (const slot of p.slots) {
      if (now - slot.createdAt < ttl) {
        fresh.push(slot);
      } else {
        // Stale slot — delete upstream chat so the account's chat history
        // doesn't accumulate. Without this, topUp fills up to N empty chats
        // per account and never reclaims them, which over hours tanks the
        // account's upstream processing latency to 200s+.
        void this.deleteSession(slot.chatId, undefined, slot.accountEmail).catch(() => {});
      }
    }
    p.slots = fresh;
    const slot = fresh.shift();
    if (!slot) return null;
    // Refill asynchronously so the next acquire also hits the pool
    this.topUp(email).catch(() => {});
    return slot.chatId;
  }

  /**
   * Acquire a fresh session. If email is provided, use that specific account.
   * Otherwise, pick the best available account (round-robin, non-throttled).
   */
  async acquire(email?: string): Promise<PoolEntry> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) {
      const mockId = process.env.TEST_SESSION_ID || 'mock-session';
      return { chatId: mockId, parentId: null, inUse: true, accountEmail: 'mock@test' };
    }

    const maxAttempts = email ? 1 : Math.max(1, getAllAccountEmails().length);
    let lastErr: unknown;
    const ACQUIRE_TIMEOUT = 30_000; // ponytail: overall timeout to prevent hanging session creation

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const resolvedEmail = email || (await pickAccount())?.email;
      // 没有可用账号时直接失败，绝不走"默认账号"路径（会绕过 inFlight 并发保护）
      if (!resolvedEmail) {
        throw new Error('No available account — all accounts busy or throttled');
      }

      try {
        // Fast path: reuse a pre-created EMPTY chat from the pool (no chats/new round trip).
        // Safe because pooled chats are brand-new (no server-side history) — the request
        // then seeds it with its own full conversation.
        if (resolvedEmail) {
          const pooledChatId = this.popPooledChat(resolvedEmail);
          if (pooledChatId) {
            const headers = await getBasicHeaders(resolvedEmail);
            const entry: PoolEntry = {
              chatId: pooledChatId,
              parentId: null,
              inUse: true,
              cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
              accountEmail: headers.email || resolvedEmail,
            };
            this.activeSessions.add(pooledChatId);
            this.activeCount++;
            this.acquiredAt.set(pooledChatId, Date.now());
            this.cachedByChat.set(pooledChatId, {
              headers: { cookie: headers.cookie, userAgent: headers.userAgent },
              email: entry.accountEmail,
            });
            logStore.log('info', 'pool', 'Session reused (pool)' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
            return entry;
          }
        }

        // Fetch headers once, pass to createSessionWithHeaders (no duplicate getBasicHeaders call)
        const result = await Promise.race([
          (async () => {
            const headers = await getBasicHeaders(resolvedEmail);
            const chatId = await this.createSessionWithHeaders(resolvedEmail, headers);
            return { headers, chatId };
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Session acquire timed out for ${resolvedEmail || '?'} after ${ACQUIRE_TIMEOUT}ms`)),
              ACQUIRE_TIMEOUT,
            ),
          ),
        ]);
        const { headers, chatId } = result;
        const entry: PoolEntry = {
          chatId,
          parentId: null,
          inUse: true,
          cachedHeaders: { cookie: headers.cookie, userAgent: headers.userAgent },
          accountEmail: headers.email || resolvedEmail,
        };
        this.activeSessions.add(chatId);
        this.activeCount++;
        this.acquiredAt.set(chatId, Date.now());
        this.cachedByChat.set(chatId, {
          headers: { cookie: headers.cookie, userAgent: headers.userAgent },
          email: entry.accountEmail,
        });
        // Refill the pool in the background for the next request
        if (resolvedEmail) this.topUp(resolvedEmail).catch(() => {});
        logStore.log('info', 'pool', 'Session acquired' + (entry.accountEmail ? ': ' + entry.accountEmail.split('@')[0] : ''));
        return entry;
      } catch (err: any) {
        lastErr = err;
        if (resolvedEmail) {
          decrementInFlight(resolvedEmail);
          if (!email && /pending activation|Bad_Request|Chats\/new returned no id/i.test(err?.message || '')) {
            throttleAccount(resolvedEmail, 30 * 60 * 1000);
            logStore.log('warn', 'pool', `Skipping account ${resolvedEmail}: ${err.message}`);
            continue;
          }
        }
        throw err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('Failed to acquire session');
  }

  async release(
    chatId: string,
    _newParentId: string | null,
    cachedHeaders?: { cookie: string; userAgent: string },
    accountEmail?: string,
    isSuccess: boolean = true,
  ): Promise<void> {
    // Idempotency guard: if chatId not tracked as active, this session was already released.
    // Prevents double-release from competing cleanup paths (setTimeout + finally).
    if (!this.activeSessions.has(chatId)) {
      return;
    }

    // Track completed request — decrement in-flight, bump total count
    // Only count successful completions toward totalRequests
    if (accountEmail) {
      decrementInFlight(accountEmail);
      if (isSuccess) {
        incrementTotalRequests(accountEmail);
      }
    }

    this.activeSessions.delete(chatId);
    this.acquiredAt.delete(chatId);
    this.cachedByChat.delete(chatId);
    if (this.activeCount > 0) this.activeCount--;
    const existingTimer = this.releaseTimers.get(chatId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.deleteSession(chatId, cachedHeaders, accountEmail);
      this.releaseTimers.delete(chatId);
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    this.releaseTimers.set(chatId, timer);

    logStore.log('info', 'pool', 'Session released' + (accountEmail ? ': ' + accountEmail.split('@')[0] : ''));
  }

  async deleteSession(chatId: string, cachedHeaders?: { cookie: string; userAgent: string }, accountEmail?: string): Promise<void> {
    if (process.env.TEST_MOCK_PLAYWRIGHT) return;
    if (config.get('DELETE_SESSION', 'true') === 'false') return;

    // Ensure we have an email for browser context lookup
    let email = accountEmail;
    if (!email) {
      try {
        const headers = await getBasicHeaders();
        email = headers.email;
      } catch {
        console.error('[SessionPool] Failed to get email for session deletion');
        return;
      }
    }

    try {
      const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
      const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
      const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/${chatId}`, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/plain, */*',
          source: 'web',
          cookie: cookieStr,
          origin: QWEN_API_BASE,
        },
        accountEmail: email,
      });
      if (!response.ok) {
        logStore.log('debug', 'pool', `[SessionPool] Delete returned ${response.status} for ${chatId.substring(0, 8)}...`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logStore.log('debug', 'pool', `[SessionPool] Delete timeout for ${chatId.substring(0, 8)}...`);
      } else {
        logStore.log('debug', 'pool', `[SessionPool] Delete failed for ${chatId.substring(0, 8)}...: ${err.message}`);
      }
    }
  }

  getStats(): {
    total: number;
    available: number;
    inUse: number;
    waiting: number;
    stuck: number;
    oldestSessionMs: number;
    activeTimeoutMs: number;
    sweeperEnabled: boolean;
  } {
    const now = Date.now();
    const threshold = this.activeTimeoutMs();
    let oldest = 0;
    let stuck = 0;
    for (const chatId of this.activeSessions) {
      const acquiredAt = this.acquiredAt.get(chatId) ?? 0;
      const age = now - acquiredAt;
      if (age > oldest) oldest = age;
      if (age > threshold) stuck++;
    }
    return {
      total: this.activeSessions.size,
      available: this.activeSessions.size - this.activeCount,
      inUse: this.activeCount,
      waiting: 0,
      stuck,
      oldestSessionMs: oldest,
      activeTimeoutMs: threshold,
      sweeperEnabled: this.sweeperInterval !== null,
    };
  }

  /**
   * Create a session using pre-fetched headers (avoids duplicate getBasicHeaders call).
   */
  private async createSessionWithHeaders(email: string | undefined, headers: BasicHeaders): Promise<string> {
    const acct = email ? getAccountByEmail(email) : null;

    const sessionBody = JSON.stringify({
      title: 'New Chat',
      models: [acct?.state?.token ? 'qwen3.7-plus' : 'qwen3.5-flash'],
      chat_mode: 'normal',
      chat_type: 't2t',
      timestamp: Date.now(),
      project_id: '',
    });

    const tokenInfo = email ? await import('./auth.ts').then((m) => m.getTokenWithAccount(email!)) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

    const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/chats/new`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      body: sessionBody,
      accountEmail: email,
    });

    if (!response.ok) {
      const bodySnippet = await response
        .text()
        .then((t) => t.substring(0, 200))
        .catch(() => 'unknown');
      logStore.log('warn', 'session', `Chats/new returned ${response.status}: ${bodySnippet.substring(0, 100)}`);
      throw new Error(`Chats/new returned ${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.startsWith('<')) {
      logStore.log('warn', 'session', `Chats/new returned HTML instead of JSON (${responseText.substring(0, 80)}...) — baxia challenge`);
      throw new Error(`Chats/new blocked by WAF — cookies may be expired`);
    }
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      logStore.log('warn', 'session', `Chats/new returned non-JSON: ${responseText.substring(0, 120)}`);
      throw new Error(`Chats/new returned non-JSON response`);
    }
    if (!json.data?.id) {
      const message = formatQwenEnvelopeError(json);
      throw new Error(`Chats/new returned no id: ${message}`);
    }

    return json.data.id;
  }

  /**
   * Convenience wrapper: fetches headers then delegates to createSessionWithHeaders.
   */
  private async createSession(email?: string): Promise<string> {
    const headers = await getBasicHeaders(email);
    return this.createSessionWithHeaders(email || '', headers);
  }
}

export const sessionPool = new SessionPool();
