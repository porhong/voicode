import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

/**
 * Extracts a single regular file from a gzipped tarball (ustar, with pax and GNU long
 * name extensions, as produced by `npm pack`) without unpacking anything else.
 */
export async function extractTarEntry(archive: string, entry: string, dest: string): Promise<void> {
  const extractor = new TarEntryExtractor(entry, dest);
  await pipeline(createReadStream(archive), createGunzip(), extractor);
  if (!extractor.found) throw new Error(`${entry} not found in ${path.basename(archive)}`);
}

const BLOCK = 512;

class TarEntryExtractor extends Writable {
  found = false;
  private pending = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private body: 'file' | 'meta' | 'skip' = 'skip';
  private metaType = '';
  private meta: Buffer[] = [];
  private nextName: string | undefined;
  private out: WriteStream | undefined;

  constructor(
    private readonly entry: string,
    private readonly dest: string,
  ) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.consume(chunk).then(() => cb(), cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    cb(this.out || this.remaining > 0 ? new Error('Truncated tar archive') : null);
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    this.out?.destroy();
    cb(err);
  }

  private async consume(chunk: Buffer): Promise<void> {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (data.length) {
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, data.length);
        const part = data.subarray(0, n);
        if (this.body === 'file') await this.writeOut(part);
        else if (this.body === 'meta') this.meta.push(Buffer.from(part));
        this.remaining -= n;
        data = data.subarray(n);
        if (this.remaining === 0) await this.endBody();
      } else if (this.padding > 0) {
        const n = Math.min(this.padding, data.length);
        this.padding -= n;
        data = data.subarray(n);
      } else if (data.length < BLOCK) {
        this.pending = Buffer.from(data);
        return;
      } else {
        const header = data.subarray(0, BLOCK);
        data = data.subarray(BLOCK);
        if (header.every((b) => b === 0)) continue; // end-of-archive marker
        await this.startEntry(header);
      }
    }
  }

  private async startEntry(header: Buffer): Promise<void> {
    const size = parseSize(header.subarray(124, 136));
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const prefix = cString(header.subarray(345, 500));
    const name = this.nextName ?? (prefix ? `${prefix}/` : '') + cString(header.subarray(0, 100));
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === 'x' || type === 'L') {
      this.body = 'meta';
      this.metaType = type;
      this.meta = [];
    } else {
      this.nextName = undefined;
      const regular = type === '0' || type === '7';
      if (regular && name === this.entry && !this.found) {
        this.found = true;
        this.body = 'file';
        this.out = createWriteStream(this.dest, { mode: 0o755 });
        this.out.on('error', (err) => this.destroy(err));
      } else {
        this.body = 'skip';
      }
    }
    if (size === 0) await this.endBody();
  }

  private async endBody(): Promise<void> {
    if (this.body === 'meta') {
      const text = Buffer.concat(this.meta).toString('utf8');
      this.nextName = this.metaType === 'L' ? cString(Buffer.from(text)) : paxPath(text);
    } else if (this.body === 'file' && this.out) {
      const out = this.out;
      this.out = undefined;
      await new Promise<void>((resolve, reject) => {
        out.once('close', resolve);
        out.once('error', reject);
        out.end();
      });
    }
    this.body = 'skip';
  }

  private writeOut(part: Buffer): Promise<void> {
    return new Promise((resolve) => {
      if (this.out!.write(part)) resolve();
      else this.out!.once('drain', resolve);
    });
  }
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

function parseSize(field: Buffer): number {
  if (field[0]! & 0x80) {
    // GNU base-256 encoding for sizes of 8 GiB and above.
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i]!;
    return n;
  }
  const text = cString(field).trim();
  const n = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Corrupt tar header');
  return n;
}

/** Returns the `path` record of a pax extended header, if any. */
function paxPath(text: string): string | undefined {
  for (const record of text.split('\n')) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match) return match[1];
  }
  return undefined;
}
