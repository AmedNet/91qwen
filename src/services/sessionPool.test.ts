import { afterEach, describe, expect, test } from 'bun:test';
import { sessionPool } from './sessionPool.ts';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

/**
 * Tests the stuck-session sweeper. The sweeper is the belt-and-suspenders
 * backstop for sessions that escape the normal acquire → release path
 * (e.g. a stream detaches before finally runs, leaving the chatId in
 * activeSessions forever). We poke the pool's internal maps directly because
 * TEST_MOCK_PLAYWRIGHT short-circuits acquire() to a constant mock id, so we
 * cannot simulate stuck sessions via the public API.
 */
const poolInternals = sessionPool as unknown as {
  activeSessions: Set<string>;
  activeCount: number;
  acquiredAt: Map<string, number>;
  cachedByChat: Map<string, { headers?: { cookie: string; userAgent: string }; email?: string }>;
  releaseTimers: Map<string, ReturnType<typeof setTimeout>>;
  sweeperInterval: ReturnType<typeof setInterval> | null;
};

function resetPool(): void {
  poolInternals.activeSessions.clear();
  poolInternals.activeCount = 0;
  poolInternals.acquiredAt.clear();
  poolInternals.cachedByChat.clear();
  for (const timer of poolInternals.releaseTimers.values()) clearTimeout(timer);
  poolInternals.releaseTimers.clear();
  if (poolInternals.sweeperInterval) {
    clearInterval(poolInternals.sweeperInterval);
    poolInternals.sweeperInterval = null;
  }
}

afterEach(() => {
  resetPool();
});

describe('SessionPool.sweepStuckSessions', () => {
  test('releases sessions older than the active timeout', () => {
    const STALE_MS = 31 * 60 * 1000;
    const FRESH_MS = 5 * 60 * 1000;
    const now = Date.now();

    poolInternals.activeSessions.add('stale-1');
    poolInternals.activeSessions.add('stale-2');
    poolInternals.activeSessions.add('fresh-1');
    poolInternals.acquiredAt.set('stale-1', now - STALE_MS);
    poolInternals.acquiredAt.set('stale-2', now - STALE_MS);
    poolInternals.acquiredAt.set('fresh-1', now - FRESH_MS);
    poolInternals.activeCount = 3;

    const { swept } = sessionPool.sweepStuckSessions();

    expect(swept.sort()).toEqual(['stale-1', 'stale-2']);
    expect(poolInternals.activeSessions.has('stale-1')).toBe(false);
    expect(poolInternals.activeSessions.has('stale-2')).toBe(false);
    expect(poolInternals.activeSessions.has('fresh-1')).toBe(true);
    expect(poolInternals.activeCount).toBe(1);
    // acquiredAt must be cleared for swept sessions so the sweeper doesn't
    // re-release them on the next tick.
    expect(poolInternals.acquiredAt.has('stale-1')).toBe(false);
    expect(poolInternals.acquiredAt.has('fresh-1')).toBe(true);
  });

  test('does not release sessions within the active timeout', () => {
    const now = Date.now();
    poolInternals.activeSessions.add('fresh-1');
    poolInternals.activeSessions.add('fresh-2');
    poolInternals.acquiredAt.set('fresh-1', now - 1000);
    poolInternals.acquiredAt.set('fresh-2', now - 29 * 60 * 1000);
    poolInternals.activeCount = 2;

    const { swept } = sessionPool.sweepStuckSessions();

    expect(swept).toEqual([]);
    expect(poolInternals.activeSessions.size).toBe(2);
    expect(poolInternals.activeCount).toBe(2);
  });

  test('does not double-release sessions that were already released normally', () => {
    const now = Date.now();
    poolInternals.activeSessions.add('manual-released');
    poolInternals.acquiredAt.set('manual-released', now - 60 * 60 * 1000);

    // Normal release path (idempotent guard removes it from activeSessions).
    void sessionPool.release('manual-released', null, undefined, undefined, true);

    const { swept } = sessionPool.sweepStuckSessions();
    expect(swept).toEqual([]);
    // Sweeper should be a no-op since release() already cleared everything.
    expect(poolInternals.activeSessions.has('manual-released')).toBe(false);
  });

  test('getStats reports stuck count, oldest age, and sweeper enabled state', () => {
    const now = Date.now();
    poolInternals.activeSessions.add('old');
    poolInternals.activeSessions.add('young');
    poolInternals.acquiredAt.set('old', now - 45 * 60 * 1000);
    poolInternals.acquiredAt.set('young', now - 60 * 1000);
    poolInternals.activeCount = 2;

    // Synthesize an enabled sweeper so getStats reflects production runtime.
    poolInternals.sweeperInterval = setInterval(() => {}, 60_000);
    if (typeof poolInternals.sweeperInterval.unref === 'function') poolInternals.sweeperInterval.unref();

    const stats = sessionPool.getStats();
    expect(stats.total).toBe(2);
    expect(stats.inUse).toBe(2);
    expect(stats.stuck).toBe(1); // only 'old' exceeds the 30min default
    expect(stats.oldestSessionMs).toBeGreaterThan(44 * 60 * 1000);
    expect(stats.activeTimeoutMs).toBe(30 * 60 * 1000);
    expect(stats.sweeperEnabled).toBe(true);
  });

  test('sweep is safe when pool is empty', () => {
    const { swept } = sessionPool.sweepStuckSessions();
    expect(swept).toEqual([]);
    expect(sessionPool.getStats().total).toBe(0);
  });
});
