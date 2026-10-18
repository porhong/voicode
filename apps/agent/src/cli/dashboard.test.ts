import { describe, expect, it } from 'vitest';
import type { AgentSnapshot } from '../agent.js';
import { renderDashboard, truncate, type DashboardView } from './dashboard.js';

const NOW = 1_800_000_000_000;
// eslint-disable-next-line no-control-regex -- colour codes
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

function snapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    startedAt: NOW - 75 * 60_000,
    urls: ['https://192.168.1.5:8443', 'https://10.0.0.2:8443'],
    tunnel: { mode: 'named', state: 'ready', url: 'https://code.example.com' },
    devices: [],
    pairedDevices: 0,
    sessions: [],
    pendingApprovals: [],
    pcSessions: [],
    mouse: { available: true, driver: 'win32-sendinput' },
    voiceMic: { available: false, driver: 'none', reason: 'VB-CABLE is not installed' },
    projects: [{ id: 'p1', name: 'voicode', path: 'D:\\voicode' }],
    pairingCode: { code: '283474', display: '283-474', expiresAt: NOW + 9 * 60_000 },
    ...over,
  };
}

function view(over: Partial<DashboardView> = {}): DashboardView {
  const snap = over.snapshot ?? snapshot();
  return {
    snapshot: snap,
    setup: {
      version: '0.1.2',
      platform: 'Windows 11 (build 26300)',
      claudeCode: { ok: true, text: 'Claude login' },
      workspace: ['D:\\Development'],
      caFingerprint: '9F:B9:65',
      qr: true,
    },
    events: [],
    pairing: snap.pairingCode
      ? { code: snap.pairingCode, url: 'https://x/#pair=1', qr: '  ▄▄▄ QR ▄▄▄\n  ███ QR ███\n' }
      : undefined,
    now: NOW,
    width: 100,
    height: 60,
    ...over,
  };
}

const online = snapshot({
  devices: [{ deviceId: 'd1', deviceName: 'Pixel 8', connections: 2 }],
  pairedDevices: 1,
  sessions: [
    {
      id: 's1',
      projectId: 'p1',
      state: 'awaiting_permission',
      createdAt: NOW,
      title: 'Fix the tunnel',
    },
    { id: 's2', projectId: 'p1', state: 'closed', createdAt: NOW },
  ],
  pendingApprovals: [
    {
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'Bash',
      title: 'Claude wants to run: npm test',
      detail: 'npm test',
      complete: true,
      canRemember: true,
      createdAt: NOW,
    },
  ],
  mouse: {
    available: true,
    driver: 'win32-sendinput',
    holder: { deviceId: 'd1', deviceName: 'Pixel 8' },
  },
});

describe('renderDashboard', () => {
  it('shows everything needed to pair while no device is online', () => {
    const text = plain(renderDashboard(view())).join('\n');
    expect(text).toContain('up 1h 15m');
    expect(text).toContain('code 283-474  expires in 9 min');
    expect(text).toContain('▄▄▄ QR ▄▄▄');
    expect(text).toContain('CA SHA-256');
    expect(text).toContain('https://10.0.0.2:8443');
    expect(text).toContain('Windows 11');
    expect(text).toContain('Waiting for a device');
    expect(text).toContain('https://code.example.com');
  });

  it('turns into a status view once a device is online', () => {
    const text = plain(renderDashboard(view({ snapshot: online, pairing: undefined }))).join('\n');
    expect(text).toContain('● Pixel 8 ×2');
    expect(text).toContain('1 open · 1 waiting for approval');
    expect(text).toContain('voicode  Fix the tunnel  waiting for approval');
    expect(text).toContain('! Claude wants to run: npm test');
    expect(text).toContain('In use by Pixel 8');
    expect(text).toContain('Off — VB-CABLE is not installed');
    expect(text).toContain('P pair another device');
    for (const hidden of ['QR', 'CA SHA-256', 'Windows 11', '10.0.0.2', 'Waiting for a device']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('asks for a code when none is valid and no device is online', () => {
    const snap = snapshot({ pairingCode: undefined, pairedDevices: 2 });
    const text = plain(renderDashboard(view({ snapshot: snap }))).join('\n');
    expect(text).toContain('none online · 2 paired, can reconnect');
    expect(text).toContain('press P for a pairing code');
    expect(text).not.toContain('Pair a device');
  });

  it('drops details before the QR code in a short window', () => {
    const lines = plain(renderDashboard(view({ height: 18 })));
    const text = lines.join('\n');
    expect(text).toContain('███ QR ███');
    expect(text).toContain('Q stop');
    expect(text).not.toContain('CA SHA-256');
    expect(lines.length).toBeLessThanOrEqual(18);
  });

  it('keeps recent events, and strips control characters from device names', () => {
    const snap = snapshot({
      devices: [{ deviceId: 'd1', deviceName: 'Evil\x1b[2Jphone', connections: 1 }],
    });
    const lines = renderDashboard(
      view({ snapshot: snap, pairing: undefined, events: [{ at: NOW, text: 'Paired phone' }] }),
    );
    expect(lines.join('\n')).not.toContain('\x1b[2J');
    expect(plain(lines).join('\n')).toContain('Paired phone');
  });
});

describe('truncate', () => {
  it('cuts to the visible width without breaking colour codes', () => {
    const line = '\x1b[32mabcdef\x1b[39m';
    expect(truncate(line, 10)).toBe(line);
    expect(plain([truncate(line, 4)])[0]).toBe('abc…');
    expect(truncate(line, 4)).toBe('\x1b[32mabc…\x1b[0m');
  });
});
