import { describe, expect, it } from 'vitest';
import type { query, Query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { silentLogger } from '../util/logger.js';
import { toUsageReport, UsageMeter } from './usage.js';

const answer = (rateLimits: Record<string, unknown> | null): SDKControlGetUsageResponse =>
  ({
    session: {},
    subscription_type: 'max',
    rate_limits_available: rateLimits !== null,
    rate_limits: rateLimits,
    behaviors: null,
  }) as unknown as SDKControlGetUsageResponse;

describe('toUsageReport', () => {
  it('lists every documented limit in order, then per-model and extra usage', () => {
    const report = toUsageReport(
      answer({
        seven_day: { utilization: 27, resets_at: '2026-10-17T16:00:00.1+00:00' },
        five_hour: { utilization: 37.4, resets_at: '2026-10-15T06:50:00Z' },
        seven_day_opus: { utilization: 120, resets_at: null },
        seven_day_sonnet: null,
        nimbus_quill: { utilization: 5, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 61, resets_at: 'not a date' }],
        extra_usage: { is_enabled: true, utilization: 12, monthly_limit: 50, used_credits: 6 },
      }),
      1000,
    );
    expect(report.available).toBe(true);
    expect(report.plan).toBe('max');
    expect(report.fetchedAt).toBe(1000);
    expect(report.limits.map((l) => [l.id, l.scope, l.utilization])).toEqual([
      ['five_hour', 'session', 37.4],
      ['seven_day', 'week', 27],
      ['seven_day_opus', 'model', 100],
      ['model:Fable', 'model', 61],
      ['extra', 'extra', 12],
    ]);
    expect(report.limits[0]!.resetsAt).toBe(Date.parse('2026-10-15T06:50:00Z'));
    expect(report.limits[3]!.resetsAt).toBeNull();
  });

  it('reports plans without limits (API key, cloud providers) as unavailable', () => {
    const report = toUsageReport(answer(null));
    expect(report.available).toBe(false);
    expect(report.limits).toEqual([]);
  });

  it('skips extra usage that is switched off', () => {
    const report = toUsageReport(answer({ extra_usage: { is_enabled: false, utilization: 0 } }));
    expect(report.limits).toEqual([]);
  });
});

function fakeProbe(results: Array<SDKControlGetUsageResponse | Error>) {
  const calls = { started: 0, asked: 0, closed: 0 };
  const queryFn = (() => {
    calls.started++;
    async function* run() {
      await new Promise(() => undefined);
      yield undefined as never;
    }
    return Object.assign(run(), {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        const next = results[Math.min(calls.asked++, results.length - 1)]!;
        if (next instanceof Error) throw next;
        return next;
      },
      close: () => {
        calls.closed++;
      },
    }) as unknown as Query;
  }) as unknown as typeof query;
  return { queryFn, calls };
}

describe('UsageMeter', () => {
  it('starts one probe when no session runs, and caches its answer for a minute', async () => {
    let now = 0;
    const { queryFn, calls } = fakeProbe([answer({ five_hour: { utilization: 10 } })]);
    const meter = new UsageMeter({
      liveQuery: () => undefined,
      logger: silentLogger(),
      queryFn,
      now: () => now,
    });
    const [a, b] = await Promise.all([meter.get(), meter.get()]);
    expect(a).toBe(b);
    expect(a.limits[0]!.utilization).toBe(10);
    now = 30_000;
    await meter.get();
    expect(calls.asked).toBe(1);
    await meter.get(true);
    expect(calls).toMatchObject({ started: 1, asked: 2 });
    meter.close();
    expect(calls.closed).toBe(1);
  });

  it('asks a live session instead of starting a probe', async () => {
    const { queryFn, calls } = fakeProbe([]);
    const live = fakeProbe([answer({ seven_day: { utilization: 44 } })]);
    const meter = new UsageMeter({
      liveQuery: () => (live.queryFn as unknown as () => Query)(),
      logger: silentLogger(),
      queryFn,
    });
    const report = await meter.get();
    expect(report.limits[0]!.utilization).toBe(44);
    expect(calls.started).toBe(0);
  });

  it('keeps the last limits with an error when Claude Code fails', async () => {
    const { queryFn } = fakeProbe([
      answer({ five_hour: { utilization: 50 } }),
      new Error('not signed in'),
      answer({ five_hour: { utilization: 55 } }),
    ]);
    const meter = new UsageMeter({ liveQuery: () => undefined, logger: silentLogger(), queryFn });
    await meter.get();
    const failed = await meter.get(true);
    expect(failed.error).toMatch(/could not report usage/);
    expect(failed.limits[0]!.utilization).toBe(50);
    // An error is never served from the cache.
    const retried = await meter.get();
    expect(retried.error).toBeUndefined();
    expect(retried.limits[0]!.utilization).toBe(55);
  });
});
