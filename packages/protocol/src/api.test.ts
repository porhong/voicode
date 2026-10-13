import { describe, expect, it } from 'vitest';
import { PairRequestSchema, normalizePairingCode } from './api.js';
import { ClientMessageSchema } from './client-messages.js';

describe('wire protocol validation', () => {
  it('rejects device names with terminal escapes, line breaks or bidi controls', () => {
    const ok = PairRequestSchema.safeParse({ code: '123456', deviceName: 'Pixel 9 — José' });
    expect(ok.success).toBe(true);
    for (const deviceName of ['evil\u001b]0;pwned\u0007', 'two\nlines', 'rtl‮flip']) {
      expect(PairRequestSchema.safeParse({ code: '123456', deviceName }).success).toBe(false);
    }
  });

  it('normalizes typed pairing codes', () => {
    expect(normalizePairingCode(' 482-917 ')).toBe('482917');
  });

  it('bounds mouse deltas and prompt sizes', () => {
    expect(ClientMessageSchema.safeParse({ type: 'mouse.move', dx: 5, dy: -5 }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'mouse.move', dx: 1e6, dy: 0 }).success).toBe(
      false,
    );
    expect(ClientMessageSchema.safeParse({ type: 'mouse.move', dx: 1.5, dy: 0 }).success).toBe(
      false,
    );
    expect(
      ClientMessageSchema.safeParse({ type: 'claude.prompt', sessionId: 's', text: '   ' }).success,
    ).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });
});
