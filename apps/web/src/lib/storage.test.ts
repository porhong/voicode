import { describe, expect, it } from 'vitest';
import { formatBytes, formatLimit } from './storage';

describe('storage formatting', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('formats limits', () => {
    expect(formatLimit(250)).toBe('250 MB');
    expect(formatLimit(2000)).toBe('2 GB');
  });
});
