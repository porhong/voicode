import os from 'node:os';
import {
  query,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { UsageLimit, UsageReport } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import { AsyncQueue } from './async-queue.js';
import { claudeExecutablePath } from './claude-executable.js';

/** A plan answer is reused this long; the phone also asks again after each turn. */
const TTL_MS = 60_000;
/** An idle probe process is closed after this long. */
const PROBE_IDLE_MS = 5 * 60_000;
/** A cold Claude Code takes about 10 s to start and answer. */
const READ_TIMEOUT_MS = 30_000;

type RateLimits = NonNullable<SDKControlGetUsageResponse['rate_limits']>;
type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

/** The plan windows Claude Code documents, in the order the phone shows them. */
const WINDOWS: Array<{
  key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_oauth_apps';
  label: string;
  short: string;
  scope: UsageLimit['scope'];
}> = [
  { key: 'five_hour', label: 'Current session', short: '5h', scope: 'session' },
  { key: 'seven_day', label: 'Weekly · all models', short: 'Week', scope: 'week' },
  { key: 'seven_day_opus', label: 'Weekly · Opus', short: 'Opus', scope: 'model' },
  { key: 'seven_day_sonnet', label: 'Weekly · Sonnet', short: 'Sonnet', scope: 'model' },
  { key: 'seven_day_oauth_apps', label: 'Weekly · apps', short: 'Apps', scope: 'apps' },
];

const percent = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;

const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

/**
 * Turns Claude Code's `/usage` data into the limits the phone draws. The endpoint is
 * experimental and carries many more (codenamed) windows; only the documented ones are
 * read, and every field is checked, so a reshaped answer drops a limit instead of
 * breaking the gauge.
 */
export function toUsageReport(res: SDKControlGetUsageResponse, now = Date.now()): UsageReport {
  const limits: UsageLimit[] = [];
  const rl: Partial<RateLimits> = res.rate_limits ?? {};
  for (const w of WINDOWS) {
    const window = rl[w.key] as Window;
    if (!window || typeof window !== 'object') continue;
    limits.push({
      id: w.key,
      label: w.label,
      short: w.short,
      scope: w.scope,
      utilization: percent(window.utilization),
      resetsAt: time(window.resets_at),
    });
  }
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const name = typeof m?.display_name === 'string' ? m.display_name.trim().slice(0, 40) : '';
    if (!name) continue;
    limits.push({
      id: `model:${name}`,
      label: `Weekly · ${name}`,
      short: name,
      scope: 'model',
      utilization: percent(m.utilization),
      resetsAt: time(m.resets_at),
    });
  }
  const extra = rl.extra_usage;
  if (extra?.is_enabled) {
    limits.push({
      id: 'extra',
      label: 'Extra usage · this month',
      short: 'Extra',
      scope: 'extra',
      utilization: percent(extra.utilization),
      resetsAt: null,
    });
  }
  return {
    available: res.rate_limits_available === true && res.rate_limits != null,
    plan: typeof res.subscription_type === 'string' ? res.subscription_type : null,
    limits,
    fetchedAt: now,
  };
}

const usageOf = (q: Query) =>
  q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude Code did not answer in time')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface UsageMeterOptions {
  /** A live SDK session to ask, if there is one (no extra process needed). */
  liveQuery: () => Query | undefined;
  logger: Logger;
  /** Injection point for tests. */
  queryFn?: typeof query;
  now?: () => number;
}

/**
 * Reads the plan's usage limits from Claude Code. Asking costs no tokens: it is the
 * same call `/usage` makes. With no phone session running, a Claude Code is started
 * with no prompt just to answer, and kept a few minutes for the next refresh.
 */
export class UsageMeter {
  private cached: UsageReport | undefined;
  private inflight: Promise<UsageReport> | undefined;
  private probe:
    { q: Query; input: AsyncQueue<SDKUserMessage>; timer?: NodeJS.Timeout } | undefined;

  constructor(private readonly opts: UsageMeterOptions) {}

  get(refresh = false): Promise<UsageReport> {
    const now = this.opts.now?.() ?? Date.now();
    if (!refresh && this.cached && !this.cached.error && now - this.cached.fetchedAt < TTL_MS) {
      return Promise.resolve(this.cached);
    }
    this.inflight ??= this.read().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  close(): void {
    const probe = this.probe;
    this.probe = undefined;
    if (!probe) return;
    clearTimeout(probe.timer);
    probe.input.end();
    probe.q.close();
  }

  private async read(): Promise<UsageReport> {
    const now = () => this.opts.now?.() ?? Date.now();
    try {
      const live = this.opts.liveQuery();
      const res = await withTimeout(live ? usageOf(live) : this.askProbe(), READ_TIMEOUT_MS);
      this.cached = toUsageReport(res, now());
    } catch (err) {
      this.opts.logger.warn({ err }, 'could not read Claude usage');
      this.close();
      // Keep the last known limits on screen, marked with what went wrong.
      this.cached = {
        available: this.cached?.available ?? false,
        plan: this.cached?.plan ?? null,
        limits: this.cached?.limits ?? [],
        fetchedAt: this.cached?.fetchedAt ?? now(),
        error: 'Claude Code could not report usage. Check that it is signed in, then refresh.',
      };
    }
    return this.cached;
  }

  private askProbe(): Promise<SDKControlGetUsageResponse> {
    if (!this.probe) {
      const input = new AsyncQueue<SDKUserMessage>();
      const executable = this.opts.queryFn ? undefined : claudeExecutablePath();
      const q = (this.opts.queryFn ?? query)({
        prompt: input,
        options: {
          // No prompt is ever sent; nothing here can run a tool.
          cwd: os.homedir(),
          settingSources: [],
          canUseTool: async () => ({ behavior: 'deny', message: 'Usage probe only' }),
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        },
      });
      // Drain the (empty) message stream so the process is not held up by backpressure.
      void (async () => {
        try {
          for await (const _ of q);
        } catch {
          // A closed probe ends its stream with an error; nothing to report.
        }
      })();
      this.probe = { q, input };
    }
    const probe = this.probe;
    clearTimeout(probe.timer);
    probe.timer = setTimeout(() => this.close(), PROBE_IDLE_MS);
    probe.timer.unref();
    return usageOf(probe.q);
  }
}
