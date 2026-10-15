import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';

/** Image types Claude accepts; anything else is refused at upload. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Attachments are kept this long: long enough for Claude to look again later in a session. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60_000;
const SWEEP_MS = 60 * 60_000;
const ID_RE = /^[0-9a-f]{32}$/;
const FILE_RE = /^([0-9a-f]{32})\.(png|jpg|gif|webp)$/;

/**
 * The image type from the file's first bytes. The phone's claimed content type is not
 * trusted: only real PNG, JPEG, GIF and WebP data is kept.
 */
export function sniffImage(data: Buffer): ImageMediaType | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1')))
    return 'image/gif';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

export interface Attachment {
  id: string;
  mediaType: ImageMediaType;
  path: string;
  bytes: number;
}

export class AttachmentError extends Error {
  constructor(
    readonly status: 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Images sent from the phone for Claude to look at. They live in the agent's own cache
 * directory (never in a project), readable by the user only, under random names, and
 * are deleted after a day. The directory is also what terminal sessions are given read
 * access to (`--add-dir`), so Claude Code can open a photo without a permission question.
 */
export class AttachmentStore {
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    readonly dir: string,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.sweep();
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  async save(data: Buffer): Promise<Attachment> {
    if (data.length > LIMITS.maxAttachmentBytes) {
      throw new AttachmentError(413, 'Image is too large');
    }
    const mediaType = sniffImage(data);
    if (!mediaType)
      throw new AttachmentError(415, 'Only PNG, JPEG, GIF and WebP images are accepted');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomUUID().replaceAll('-', '');
    const file = path.join(this.dir, `${id}.${EXTENSIONS[mediaType]}`);
    // `wx`: never overwrite; mode 0600: only this user can read the photo.
    await writeFile(file, data, { flag: 'wx', mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    return { id, mediaType, path: file, bytes: data.length };
  }

  /** An attachment by id, if it still exists. Ids are checked so no other path can be named. */
  async get(id: string): Promise<Attachment | undefined> {
    if (!ID_RE.test(id)) return undefined;
    for (const [mediaType, ext] of Object.entries(EXTENSIONS) as Array<[ImageMediaType, string]>) {
      const file = path.join(this.dir, `${id}.${ext}`);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile()) return { id, mediaType, path: file, bytes: info.size };
    }
    return undefined;
  }

  /** The image as base64, for an Agent SDK image block. */
  async readBase64(attachment: Attachment): Promise<string> {
    return (await readFile(attachment.path)).toString('base64');
  }

  /** Removes attachments older than a day (and anything else misplaced in the folder). */
  async sweep(): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const file = path.join(this.dir, name);
      const info = await stat(file).catch(() => undefined);
      if (!info) continue;
      const expired = this.now() - info.mtimeMs > ATTACHMENT_TTL_MS;
      if (expired || !FILE_RE.test(name)) {
        await rm(file, { recursive: true, force: true }).catch(() => undefined);
        removed++;
      }
    }
    if (removed) this.logger.debug({ removed }, 'old attachments removed');
    return removed;
  }
}
