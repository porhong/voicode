import { describe, expect, it } from 'vitest';
import type { UsageLimit } from '@voicecode/protocol';
import { layoutRings, padLimits } from '../components/UsagePad';
import { describeLimit, resetsIn, tightest, usageLevel } from './usage';

const limit = (id: string, utilization: number | null): UsageLimit => ({
  id,
  label: id,
  short: id,
  scope: 'week',
  utilization,
  resetsAt: null,
});

describe('usage helpers', () => {
  it('grades a limit and says so in words', () => {
    expect([10, 75, 89.9, 90, null].map(usageLevel)).toEqual([
      'ok',
      'near',
      'near',
      'critical',
      'unknown',
    ]);
    expect(describeLimit({ ...limit('Weekly', 92), resetsAt: 3 * 3_600_000 }, 0)).toBe(
      'Weekly: 92% used (at the limit), resets in 3 h 0 min',
    );
  });

  it('counts down to the reset', () => {
    expect(resetsIn(20_000, 0)).toBe('now');
    expect(resetsIn(40 * 60_000, 0)).toBe('in 40 min');
    expect(resetsIn((2 * 60 + 14) * 60_000, 0)).toBe('in 2 h 14 min');
    expect(resetsIn((3 * 24 + 5) * 3_600_000, 0)).toBe('in 3 d 5 h');
  });

  it('finds the fullest limit', () => {
    expect(tightest([limit('a', 20), limit('b', null), limit('c', 70)])?.id).toBe('c');
    expect(tightest([])).toBeUndefined();
  });
});

describe('layoutRings', () => {
  it('stacks two rings in the narrow portrait pad', () => {
    const layout = layoutRings([limit('5h', 37), limit('week', 27)], 56, 116);
    expect(layout.cols).toBe(1);
    expect(layout.shown).toHaveLength(2);
    expect(layout.ring).toBeGreaterThanOrEqual(34);
  });

  it('keeps the fullest limits, in their order, when not all fit', () => {
    const limits = [limit('5h', 10), limit('week', 80), limit('opus', 95), limit('apps', 5)];
    const layout = layoutRings(limits, 56, 116);
    expect(layout.shown.map((l) => l.id)).toEqual(['week', 'opus']);
  });

  it('lays every limit out side by side on the full deck, with reset times', () => {
    const limits = ['a', 'b', 'c', 'd', 'e'].map((id) => limit(id, 50));
    const layout = layoutRings(limits, 330, 150);
    expect(layout.shown).toHaveLength(5);
    expect(layout.ring).toBeGreaterThanOrEqual(34);
  });

  it('draws nothing in a box too small for any ring', () => {
    expect(layoutRings([limit('5h', 1)], 20, 20).shown).toEqual([]);
  });
});

describe('padLimits', () => {
  const limit = (id: string, scope: UsageLimit['scope']): UsageLimit => ({
    id,
    label: id,
    short: id,
    scope,
    utilization: 10,
    resetsAt: null,
  });

  it('keeps the 5-hour session and the week for the pad', () => {
    const limits = [
      limit('five_hour', 'session'),
      limit('seven_day', 'week'),
      limit('model:Fable', 'model'),
      limit('extra', 'extra'),
    ];
    expect(padLimits(limits).map((l) => l.id)).toEqual(['five_hour', 'seven_day']);
  });

  it('falls back to every limit when neither is reported', () => {
    const limits = [limit('model:Fable', 'model')];
    expect(padLimits(limits)).toEqual(limits);
  });
});
