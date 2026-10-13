import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../util/logger.js';
import { FakeMouseDriver } from '../test-utils/fakes.js';
import { InputRouter, type ClientIdentity } from './input-router.js';

const phone: ClientIdentity = { connectionId: 'c1', deviceId: 'd1', deviceName: 'Phone' };
const tablet: ClientIdentity = { connectionId: 'c2', deviceId: 'd2', deviceName: 'Tablet' };

function setup(options: { leaseIdleMs?: number; flushIntervalMs?: number } = {}) {
  let now = 1_000;
  const driver = new FakeMouseDriver();
  const router = new InputRouter(silentLogger(), {
    leaseIdleMs: options.leaseIdleMs ?? 60_000,
    flushIntervalMs: options.flushIntervalMs ?? 8,
    now: () => now,
  });
  router.attach(driver, { details: {} });
  return { router, driver, advance: (ms: number) => (now += ms) };
}

describe('InputRouter', () => {
  let router: InputRouter | undefined;
  afterEach(async () => router?.stop());

  it('rejects input without a lease', () => {
    const t = setup();
    router = t.router;
    expect(t.router.move(phone, 5, 5)).toMatchObject({ ok: false, code: 'mouse_not_leased' });
    expect(t.driver.calls).toEqual([]);
  });

  it('grants one exclusive lease and allows forced takeover', () => {
    const t = setup();
    router = t.router;
    expect(t.router.acquire(phone).ok).toBe(true);
    expect(t.router.acquire(tablet)).toMatchObject({ ok: false, code: 'mouse_lease_held' });
    expect(t.router.move(tablet, 1, 1).ok).toBe(false);
    expect(t.router.acquire(tablet, true).ok).toBe(true);
    expect(t.router.holds(tablet)).toBe(true);
    expect(t.router.status().holder).toEqual({ deviceId: 'd2', deviceName: 'Tablet' });
  });

  it('coalesces moves within the flush interval and flushes before buttons', () => {
    const t = setup();
    router = t.router;
    t.router.acquire(phone);
    t.router.move(phone, 3, 4); // first move flushes immediately
    t.router.move(phone, 1, 1); // within 8ms: buffered
    t.router.move(phone, 2, -1);
    t.router.button(phone, 'left', true);
    expect(t.driver.calls).toEqual(['move 3 4', 'move 3 0', 'down left']);
  });

  it('releases held buttons when the holder disconnects', () => {
    const t = setup();
    router = t.router;
    t.router.acquire(phone);
    t.router.button(phone, 'left', true);
    t.router.button(phone, 'right', true);
    t.router.disconnect(phone);
    expect(t.driver.calls).toEqual(['down left', 'down right', 'up left', 'up right']);
    expect(t.router.status().holder).toBeUndefined();
  });

  it('releases the previous holder’s buttons on takeover', () => {
    const t = setup();
    router = t.router;
    t.router.acquire(phone);
    t.router.button(phone, 'left', true);
    t.router.acquire(tablet, true);
    expect(t.driver.calls).toEqual(['down left', 'up left']);
  });

  it('ignores duplicate button transitions', () => {
    const t = setup();
    router = t.router;
    t.router.acquire(phone);
    t.router.button(phone, 'left', true);
    t.router.button(phone, 'left', true);
    t.router.button(phone, 'left', false);
    t.router.button(phone, 'left', false);
    expect(t.driver.calls).toEqual(['down left', 'up left']);
  });

  it('drops the lease and reports unavailability when the driver dies', () => {
    const t = setup();
    router = t.router;
    t.router.acquire(phone);
    t.driver.crash();
    expect(t.router.status()).toMatchObject({ available: false, reason: 'crashed' });
    expect(t.router.move(phone, 1, 1)).toMatchObject({ ok: false, code: 'mouse_unavailable' });
  });
});
