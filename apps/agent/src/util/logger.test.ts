import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateIfLarge } from './logger.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'vc-log-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('rotateIfLarge', () => {
  it('moves a log over the limit to .1, replacing the previous copy', () => {
    const log = path.join(dir, 'agent.log');
    writeFileSync(`${log}.1`, 'older');
    writeFileSync(log, 'small');
    expect(rotateIfLarge(log, 10)).toBe(false);
    writeFileSync(log, 'a much longer line');
    expect(rotateIfLarge(log, 10)).toBe(true);
    expect(readFileSync(`${log}.1`, 'utf8')).toBe('a much longer line');
  });

  it('ignores a missing log', () => {
    expect(rotateIfLarge(path.join(dir, 'missing.log'), 10)).toBe(false);
  });
});
