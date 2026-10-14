import { describe, expect, it } from 'vitest';
import { createDownsampler } from './pcm';

const constant = (n: number, v: number) => new Float32Array(n).fill(v);

describe('createDownsampler', () => {
  it('reduces 48 kHz to 16 kHz by averaging and scales to 16-bit', () => {
    const down = createDownsampler(48_000, 16_000);
    const out = down(constant(4800, 0.5));
    expect(out).toHaveLength(1600);
    expect(out[0]).toBe(16384);
    expect(out[1599]).toBe(16384);
  });

  it('carries the fractional remainder across chunks for odd ratios', () => {
    const down = createDownsampler(44_100, 16_000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += down(constant(4410, 0.1)).length;
    // 44 100 input samples per second → 16 000 output samples, give or take the last carry.
    expect(total).toBeGreaterThanOrEqual(15_998);
    expect(total).toBeLessThanOrEqual(16_000);
  });

  it('passes same-rate audio through unchanged and clips out-of-range samples', () => {
    const down = createDownsampler(16_000, 16_000);
    const out = down(new Float32Array([0, 1, -1, 2, -2, 0.25]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 8192]);
  });

  it('handles chunks shorter than one output sample', () => {
    const down = createDownsampler(48_000, 16_000);
    expect(down(constant(2, 0.5))).toHaveLength(0);
    expect(down(constant(1, 0.5))).toHaveLength(1);
    expect(down(constant(3, 0.5))).toHaveLength(1);
  });
});
