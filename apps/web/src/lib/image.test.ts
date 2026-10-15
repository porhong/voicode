import { describe, expect, it } from 'vitest';
import { fitWithin, MAX_SIDE, outputType } from './image';

describe('fitWithin', () => {
  it('scales the long side down to the limit and keeps the shape', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_SIDE, height: 1176 });
    expect(fitWithin(1170, 2532)).toEqual({ width: 725, height: MAX_SIDE });
  });

  it('never enlarges a small image', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('outputType', () => {
  it('keeps screenshots as PNG unless they are large, and sends photos as JPEG', () => {
    expect(outputType('image/png', 725 * 1568)).toBe('image/png');
    expect(outputType('image/png', 1568 * 1568)).toBe('image/jpeg');
    expect(outputType('image/heic', 1000)).toBe('image/jpeg');
    expect(outputType('image/jpeg', 1000)).toBe('image/jpeg');
  });
});
