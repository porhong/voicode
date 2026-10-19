import { describe, expect, it } from 'vitest';
import { AUDIO, LIMITS } from '@voicecode/protocol';
import type { ClientIdentity } from '../mouse/input-router.js';
import { FakeMicDriver } from '../test-utils/fakes.js';
import { silentLogger } from '../util/logger.js';
import { MicRouter } from './mic-router.js';

const phone: ClientIdentity = { connectionId: 'c1', deviceId: 'd1', deviceName: 'Phone' };
const tablet: ClientIdentity = { connectionId: 'c2', deviceId: 'd2', deviceName: 'Tablet' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (ms = 100) => Buffer.alloc((AUDIO.sampleRate * AUDIO.bytesPerSample * ms) / 1000, 1);

function setup() {
  let now = 1_000_000;
  const driver = new FakeMicDriver();
  const router = new MicRouter(silentLogger(), { leaseIdleMs: 10_000, now: () => now });
  router.attach(driver, { device: 'Fake Cable' });
  return { driver, router, tick: (ms: number) => (now += ms) };
}

describe('MicRouter', () => {
  it('refuses audio without the lease and plays it once the lease is held', async () => {
    const { driver, router } = setup();
    expect(router.write(phone, frame()).ok).toBe(false);
    expect(router.acquire(phone)).toEqual({ ok: true });
    await Promise.resolve();
    expect(driver.calls).toEqual(['activate']);
    expect(router.write(phone, frame())).toEqual({ ok: true });
    expect(driver.frames).toHaveLength(1);
    expect(router.status().holder?.deviceName).toBe('Phone');
  });

  it('keeps one holder at a time unless forced', () => {
    const { router } = setup();
    router.acquire(phone);
    const refused = router.acquire(tablet);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('mic_lease_held');
    expect(router.acquire(tablet, true).ok).toBe(true);
    expect(router.holds(phone)).toBe(false);
    expect(router.write(phone, frame()).ok).toBe(false);
  });

  it('rejects malformed frames and audio faster than real time', () => {
    const { driver, router, tick } = setup();
    router.acquire(phone);
    expect(router.write(phone, Buffer.alloc(0)).ok).toBe(false);
    expect(router.write(phone, Buffer.alloc(3)).ok).toBe(false);
    expect(router.write(phone, frame(AUDIO.maxFrameMs + 100)).ok).toBe(false);
    // Two seconds of burst are allowed, then the live rate.
    const burst = (2 * LIMITS.maxAudioBytesPerSecond) / frame().length;
    for (let i = 0; i < burst; i++) expect(router.write(phone, frame()).ok).toBe(true);
    const limited = router.write(phone, frame());
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.code).toBe('rate_limited');
    tick(100);
    expect(router.write(phone, frame()).ok).toBe(true);
    expect(driver.frames).toHaveLength(burst + 1);
  });

  it('holds audio until Claude Code records, then plays it at real time before restoring', async () => {
    const driver = new FakeMicDriver();
    const router = new MicRouter(silentLogger(), { leaseIdleMs: 10_000 });
    router.attach(driver, { device: 'Fake Cable' });
    router.hold();
    router.acquire(phone);
    for (let i = 0; i < 5; i++) expect(router.write(phone, frame()).ok).toBe(true);
    expect(driver.frames).toHaveLength(0);
    // Let go before recording started: the default input stays switched for the audio.
    router.release(phone);
    await Promise.resolve();
    expect(driver.calls).toEqual(['activate']);

    const start = Date.now();
    router.resume();
    // Paced like real time, not dumped into the device's small buffer.
    expect(driver.frames.length).toBeGreaterThan(0);
    expect(driver.frames.length).toBeLessThan(5);
    await router.played(5_000);
    expect(driver.frames).toHaveLength(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    await sleep(350);
    expect(driver.calls).toEqual(['activate', 'deactivate']);
    await router.stop();
  });

  it('drops held audio when the recording never starts', async () => {
    const driver = new FakeMicDriver();
    const router = new MicRouter(silentLogger(), { leaseIdleMs: 10_000 });
    router.attach(driver, { device: 'Fake Cable' });
    router.hold();
    router.acquire(phone);
    router.write(phone, frame());
    router.release(phone);
    router.discard();
    await router.played(1_000);
    await sleep(350);
    expect(driver.frames).toHaveLength(0);
    expect(driver.calls).toEqual(['activate', 'deactivate']);
    // The next recording plays live again.
    router.acquire(phone);
    router.write(phone, frame());
    expect(driver.frames).toHaveLength(1);
    await router.stop();
  });

  it('ends the lease on release, disconnect, idleness and driver exit', async () => {
    const { driver, router, tick } = setup();
    router.acquire(phone);
    expect(router.release(phone).ok).toBe(true);
    await Promise.resolve();
    expect(driver.calls).toEqual(['activate', 'deactivate']);
    expect(router.release(phone).ok).toBe(false);

    router.acquire(phone);
    router.disconnect(phone);
    expect(router.status().holder).toBeUndefined();

    router.acquire(phone);
    tick(11_000);
    (router as unknown as { expireIdleLease(): void }).expireIdleLease();
    expect(router.status().holder).toBeUndefined();

    router.acquire(phone);
    driver.crash();
    expect(router.status()).toMatchObject({ available: false, reason: 'crashed' });
    expect(router.acquire(phone).ok).toBe(false);
    await router.stop();
  });
});
