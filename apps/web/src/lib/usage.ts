import type { UsageLimit } from '@voicecode/protocol';

/** How close a limit is: drawn neutral, amber from 75 %, red from 90 %. */
export type UsageLevel = 'ok' | 'near' | 'critical' | 'unknown';

export function usageLevel(utilization: number | null): UsageLevel {
  if (utilization === null) return 'unknown';
  if (utilization >= 90) return 'critical';
  if (utilization >= 75) return 'near';
  return 'ok';
}

/** Spoken and written next to the number, so colour is never the only signal. */
export const LEVEL_TEXT: Record<UsageLevel, string> = {
  ok: '',
  near: 'Near the limit',
  critical: 'At the limit',
  unknown: 'Not reported',
};

export function percentText(utilization: number | null): string {
  return utilization === null ? '–' : `${Math.round(utilization)}%`;
}

/** "in 2 h 14 min", "in 3 d 5 h", "in 40 min", "now". */
export function resetsIn(resetsAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** "Resets in 2 h 14 min · Thu 16:50", or the monthly note for extra usage. */
export function resetText(limit: UsageLimit, now = Date.now()): string | undefined {
  if (limit.scope === 'extra') return 'Monthly spending cap';
  if (limit.resetsAt === null) return undefined;
  const at = new Date(limit.resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const when = sameDay ? clock : `${at.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  return `Resets ${resetsIn(limit.resetsAt, now)} · ${when}`;
}

/** The limit that will stop Claude first: the fullest one. */
export function tightest(limits: UsageLimit[]): UsageLimit | undefined {
  return limits.reduce<UsageLimit | undefined>(
    (top, l) => ((l.utilization ?? -1) > (top?.utilization ?? -1) ? l : top),
    undefined,
  );
}

/** One line for the deck display and screen readers. */
export function describeLimit(limit: UsageLimit, now = Date.now()): string {
  const level = LEVEL_TEXT[usageLevel(limit.utilization)];
  const reset = limit.resetsAt !== null ? `, resets ${resetsIn(limit.resetsAt, now)}` : '';
  return `${limit.label}: ${percentText(limit.utilization)} used${level ? ` (${level.toLowerCase()})` : ''}${reset}`;
}

export function planName(plan: string | null): string {
  if (!plan) return 'Claude plan';
  return `${plan[0]!.toUpperCase()}${plan.slice(1)} plan`;
}
