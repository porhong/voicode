import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '@voicecode/protocol';
import { silentLogger } from '../util/logger.js';
import { ATTACHMENT_TTL_MS, AttachmentError, AttachmentStore, sniffImage } from './attachments.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const GIF = Buffer.from('GIF89a......', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

let dir: string;
let store: AttachmentStore;
beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'vc-att-')), 'attachments');
  store = new AttachmentStore(dir, silentLogger());
  await store.start();
});
afterEach(async () => {
  store.stop();
  await rm(path.dirname(dir), { recursive: true, force: true });
});

describe('sniffImage', () => {
  it('recognises images by their bytes, not their name', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('MZ\x90\x00'))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('AttachmentStore', () => {
  it('keeps images under random names and finds them by id only', async () => {
    const saved = await store.save(JPEG);
    expect(saved).toMatchObject({ mediaType: 'image/jpeg', bytes: JPEG.length });
    expect(saved.id).toMatch(/^[0-9a-f]{32}$/);
    expect(path.dirname(saved.path)).toBe(dir);
    expect(path.basename(saved.path)).toBe(`${saved.id}.jpg`);
    expect(await store.get(saved.id)).toEqual(saved);
    expect(await store.readBase64(saved)).toBe(JPEG.toString('base64'));
    // Anything that is not an id cannot name a file.
    expect(await store.get('../config')).toBeUndefined();
    expect(await store.get(`${saved.id}.jpg`)).toBeUndefined();
    expect(await store.get('0'.repeat(32))).toBeUndefined();
  });

  it('refuses what is not an image, and images over the limit', async () => {
    await expect(store.save(Buffer.from('not an image'))).rejects.toMatchObject({ status: 415 });
    const big = Buffer.concat([JPEG, Buffer.alloc(LIMITS.maxAttachmentBytes)]);
    await expect(store.save(big)).rejects.toBeInstanceOf(AttachmentError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('deletes attachments after a day, and anything misplaced in its folder', async () => {
    const fresh = await store.save(PNG);
    const old = await store.save(GIF);
    const past = (Date.now() - ATTACHMENT_TTL_MS - 60_000) / 1000;
    await utimes(old.path, past, past);
    await writeFile(path.join(dir, 'stray.txt'), 'x');
    expect(await store.sweep()).toBe(2);
    expect(await store.get(old.id)).toBeUndefined();
    expect(await store.get(fresh.id)).toBeDefined();
    expect((await stat(fresh.path)).isFile()).toBe(true);
  });
});
