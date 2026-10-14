import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadClaudeCode, type ClaudeCodePackage } from './claude-executable.js';

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000755\0', 100);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function entry(name: string, body: Buffer, type = '0'): Buffer {
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header(name, body.length, type), body, pad]);
}

function paxEntry(realName: string, body: Buffer): Buffer {
  const rest = ` path=${realName}\n`;
  let len = rest.length + 1;
  while (`${len}${rest}`.length !== len) len++;
  return Buffer.concat([
    entry('PaxHeader/x', Buffer.from(`${len}${rest}`), 'x'),
    entry('truncated-name', body),
  ]);
}

function tgz(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';

function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { status })) as typeof fetch;
}

describe('downloadClaudeCode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vc-claude-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pkg(archive: Buffer): ClaudeCodePackage {
    return {
      name: '@anthropic-ai/claude-agent-sdk-test',
      version: '1.2.3',
      url: 'https://registry.example/claude.tgz',
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    };
  }

  it('verifies the archive and extracts only the binary, across chunk boundaries', async () => {
    const exe = randomBytes(200_000);
    const archive = tgz(
      entry('package/package.json', Buffer.from('{}')),
      paxEntry(`package/${binary}`, exe),
      entry('package/README.md', Buffer.from('readme')),
    );
    const dest = path.join(dir, '1.2.3', binary);
    const progress: number[] = [];
    await downloadClaudeCode(pkg(archive), dest, (n) => progress.push(n), fakeFetch(archive));

    expect(readFileSync(dest).equals(exe)).toBe(true);
    expect(progress.at(-1)).toBe(archive.length);
    expect(readdirSync(path.dirname(dest))).toEqual([binary]);
  });

  it('rejects an archive that does not match the pinned integrity', async () => {
    const good = tgz(entry(`package/${binary}`, Buffer.from('real')));
    const evil = tgz(entry(`package/${binary}`, Buffer.from('evil')));
    const dest = path.join(dir, '1.2.3', binary);
    await expect(downloadClaudeCode(pkg(good), dest, undefined, fakeFetch(evil))).rejects.toThrow(
      /integrity/,
    );
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(path.dirname(dest))).toEqual([]);
  });

  it('reports HTTP errors and missing entries', async () => {
    const archive = tgz(entry('package/other', Buffer.from('x')));
    const dest = path.join(dir, '1.2.3', binary);
    await expect(
      downloadClaudeCode(pkg(archive), dest, undefined, fakeFetch(archive, 404)),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      downloadClaudeCode(pkg(archive), dest, undefined, fakeFetch(archive)),
    ).rejects.toThrow(/not found/);
    expect(existsSync(dest)).toBe(false);
  });
});
