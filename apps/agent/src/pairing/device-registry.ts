import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { generateSecret, hashSecret, verifySecret } from '@voicecode/security';
import { readJsonFile, writeFileAtomic } from '../util/fs.js';

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().optional(),
  userAgent: z.string().optional(),
});
const StoreSchema = z.object({ version: z.literal(1), devices: z.array(DeviceSchema) });

export type DeviceRecord = z.infer<typeof DeviceSchema>;
export type PublicDevice = Omit<DeviceRecord, 'tokenHash'>;

/** How often `lastSeenAt` is flushed to disk at most. */
const TOUCH_FLUSH_MS = 60_000;

/**
 * Paired devices and their credentials. Only SHA-256 hashes of device secrets are
 * persisted. The credential presented by a browser is `<deviceId>.<secret>`.
 */
export class DeviceRegistry extends EventEmitter<{ revoked: [deviceId: string] }> {
  private devices = new Map<string, DeviceRecord>();
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(file);
    const raw = await readJsonFile<unknown>(file);
    if (raw !== undefined) {
      const parsed = StoreSchema.parse(raw);
      for (const d of parsed.devices) registry.devices.set(d.id, d);
    }
    return registry;
  }

  list(): PublicDevice[] {
    return [...this.devices.values()].map(({ tokenHash: _omit, ...rest }) => rest);
  }

  get(id: string): PublicDevice | undefined {
    return this.list().find((d) => d.id === id);
  }

  async add(
    name: string,
    userAgent?: string,
  ): Promise<{ device: PublicDevice; credential: string }> {
    const id = randomUUID();
    const secret = generateSecret();
    const record: DeviceRecord = {
      id,
      name,
      tokenHash: hashSecret(secret),
      createdAt: Date.now(),
      userAgent: userAgent?.slice(0, 256),
    };
    this.devices.set(id, record);
    await this.persist();
    const { tokenHash: _omit, ...device } = record;
    return { device, credential: `${id}.${secret}` };
  }

  /** Returns the device for a presented credential, or undefined. Constant-time on the secret. */
  authenticate(credential: string | undefined): PublicDevice | undefined {
    if (!credential) return undefined;
    const dot = credential.indexOf('.');
    if (dot <= 0) return undefined;
    const record = this.devices.get(credential.slice(0, dot));
    if (!record || !verifySecret(credential.slice(dot + 1), record.tokenHash)) return undefined;
    record.lastSeenAt = Date.now();
    this.scheduleFlush();
    const { tokenHash: _omit, ...device } = record;
    return device;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.devices.delete(id)) return false;
    await this.persist();
    this.emit('revoked', id);
    return true;
  }

  async revokeAll(): Promise<number> {
    const ids = [...this.devices.keys()];
    this.devices.clear();
    await this.persist();
    for (const id of ids) this.emit('revoked', id);
    return ids.length;
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
      await this.persist();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.persist();
    }, TOUCH_FLUSH_MS);
    this.flushTimer.unref();
  }

  private async persist(): Promise<void> {
    const data = { version: 1 as const, devices: [...this.devices.values()] };
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}
