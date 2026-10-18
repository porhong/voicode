import type { SessionSummary } from '@voicecode/protocol';
import type { PairingCode } from '@voicecode/security';
import pc from 'picocolors';
import qrcode from 'qrcode-terminal';
import type { Agent, AgentSnapshot, AgentTunnelInfo } from '../agent.js';
import { formatDuration } from './shared.js';
import { clean, fail, ok, warn } from './ui.js';

/**
 * The live screen `start` shows in an interactive terminal. Until a device is online it
 * carries everything needed to pair one (URLs, code, QR); once one is, it turns into a
 * compact status view (devices, sessions, approvals, mouse, mic, tunnel) and keeps the
 * pairing details out of the way until P asks for a new code.
 */

export interface DashboardSetup {
  version: string;
  platform: string;
  claudeCode: { ok: boolean; text: string };
  workspace: string[];
  caFingerprint: string;
  /** False with `--no-qr`: the code is shown without its QR. */
  qr: boolean;
}

export interface DashboardEvent {
  at: number;
  text: string;
}

export interface DashboardView {
  snapshot: AgentSnapshot;
  setup: DashboardSetup;
  events: DashboardEvent[];
  /** The pairing panel, when it is shown; `qr` is the rendered code once it is ready. */
  pairing?: { code: PairingCode; url: string; qr?: string };
  now: number;
  width: number;
  height: number;
}

/** A group of lines; when the window is too short, the highest `drop` goes first (0 stays). */
interface Block {
  lines: string[];
  drop: number;
  /** Continues the block before it, without a blank line in between. */
  attached?: boolean;
}

const LABEL = 14;
const INDENT = ' '.repeat(2 + LABEL);
const MAX_SESSIONS = 4;
const MAX_APPROVALS = 3;
const MAX_EVENTS = 5;

const row = (label: string, value: string) => `  ${pc.dim(label.padEnd(LABEL))}${value}`;

export function renderDashboard(view: DashboardView): string[] {
  const { snapshot: s, setup, now } = view;
  const online = s.devices.length > 0;
  const tunnelUrl = s.tunnel.mode !== 'off' && 'url' in s.tunnel ? s.tunnel.url : undefined;
  const blocks: Block[] = [];

  blocks.push({
    drop: 0,
    lines: [
      `${pc.bold('VoiceCode Agent')}  ${pc.dim(`v${setup.version}`)}   ${ok('●')} Running ${pc.dim(
        `· up ${formatDuration(now - s.startedAt)}`,
      )}`,
    ],
  });

  const status: string[] = [];
  status.push(
    row(
      'Devices',
      online
        ? s.devices
            .map(
              (d) =>
                `${ok('●')} ${clean(d.deviceName)}${d.connections > 1 ? pc.dim(` ×${d.connections}`) : ''}`,
            )
            .join('   ')
        : pc.dim(
            `none online${s.pairedDevices ? ` · ${s.pairedDevices} paired, can reconnect` : ''}`,
          ),
    ),
  );
  status.push(
    row(
      'Claude Code',
      setup.claudeCode.ok ? ok(setup.claudeCode.text) : warn(setup.claudeCode.text),
    ),
  );
  const open = s.sessions.filter((x) => x.state !== 'closed');
  if (online || open.length) {
    const waiting = open.filter((x) => x.state === 'awaiting_permission').length;
    status.push(
      row(
        'Sessions',
        open.length
          ? `${open.length} open${waiting ? warn(` · ${waiting} waiting for approval`) : ''}`
          : pc.dim('none yet — start one from the phone'),
      ),
    );
    for (const session of open.slice(0, MAX_SESSIONS)) status.push(sessionLine(session, s));
    if (open.length > MAX_SESSIONS)
      status.push(INDENT + pc.dim(`+${open.length - MAX_SESSIONS} more`));
    for (const request of s.pendingApprovals.slice(0, MAX_APPROVALS)) {
      status.push(
        `${INDENT}${warn('!')} ${clean(request.title)} ${pc.dim('(answer on the phone)')}`,
      );
    }
  }
  if (s.pcSessions.length) {
    const count = (status: string) => s.pcSessions.filter((x) => x.status === status).length;
    const parts = [`${s.pcSessions.length} on this PC`];
    if (count('working')) parts.push(`${count('working')} working`);
    if (count('waiting')) parts.push(warn(`${count('waiting')} waiting`));
    status.push(row('PC sessions', parts.join(pc.dim(' · '))));
  }
  status.push(
    row(
      'Mouse',
      !s.mouse.available
        ? warn(`Unavailable — ${s.mouse.reason ?? 'no driver'}`)
        : s.mouse.holder
          ? `${ok('In use')} by ${clean(s.mouse.holder.deviceName)}`
          : `${ok('Ready')}${online ? '' : pc.dim(` (${s.mouse.driver})`)}`,
    ),
  );
  status.push(
    row(
      'Phone mic',
      !s.voiceMic.available
        ? pc.dim(`Off — ${s.voiceMic.reason ?? 'no driver'}`)
        : s.voiceMic.holder
          ? `${ok('Streaming')} from ${clean(s.voiceMic.holder.deviceName)}`
          : `${ok('Ready')}${online || !s.voiceMic.device ? '' : pc.dim(` (${s.voiceMic.device})`)}`,
    ),
  );
  if (s.tunnel.mode !== 'off') status.push(row('Tunnel', tunnelCell(s.tunnel)));
  const lanUrl = s.urls[0] ?? '';
  status.push(row('LAN URL', tunnelUrl ? lanUrl : pc.bold(lanUrl)));
  blocks.push({ drop: 1, lines: status });

  if (!online) {
    // Only needed to set a device up; hidden once one is online.
    const details = s.urls.slice(1).map((url) => INDENT + url);
    details.push(row('Platform', setup.platform));
    details.push(
      row(
        'Projects',
        s.projects.map((p) => p.name).join(', ') ||
          (setup.workspace.length
            ? pc.dim('none yet')
            : warn('none — add a folder with --root <dir>')),
      ),
    );
    if (setup.workspace.length) details.push(row('Workspace', setup.workspace.join(', ')));
    // A cut-off fingerprint can't be compared, so a narrow window gets it on two lines.
    const fp = setup.caFingerprint;
    const split = fp.indexOf(':', Math.floor(fp.length / 2) - 1);
    if (INDENT.length + fp.length < view.width || split < 0) {
      details.push(row('CA SHA-256', pc.dim(fp)));
    } else {
      details.push(row('CA SHA-256', pc.dim(fp.slice(0, split + 1))));
      details.push(INDENT + pc.dim(fp.slice(split + 1)));
    }
    blocks.push({ drop: 2, lines: details, attached: true });
  }

  if (view.pairing) {
    const { code, qr } = view.pairing;
    const lines = [
      `  ${pc.bold('Pair a device')}   code ${pc.bold(code.display)}  ${pc.dim(
        `expires in ${Math.max(0, Math.round((code.expiresAt - now) / 60_000))} min`,
      )}`,
      pc.dim('  Scan with your phone to open and pair:'),
    ];
    if (qr) lines.push(...qr.trimEnd().split('\n'));
    blocks.push({ drop: 0, lines });
    blocks.push({
      drop: 3,
      lines: tunnelUrl
        ? [
            pc.dim('  The tunnel URL works on any phone without installing a certificate.'),
            warn(
              '  It is reachable from the internet: only share pairing codes with your devices.',
            ),
          ]
        : [
            pc.dim(`  First time on a device? Install the CA from ${lanUrl}/voicecode-ca.crt`),
            pc.dim('  so the browser trusts the agent (required for the microphone).'),
          ],
    });
  }

  if (view.events.length) {
    blocks.push({
      drop: online ? 2 : 3,
      lines: [
        pc.dim('  Recent'),
        ...view.events
          .slice(-MAX_EVENTS)
          .map((e) => `  ${pc.dim(new Date(e.at).toLocaleTimeString())} ${e.text}`),
      ],
    });
  }

  const keys = `  ${pc.bold('P')} ${pc.dim(view.pairing ? 'new code' : online ? 'pair another device' : 'pairing code')}   ${pc.bold('Q')} ${pc.dim('stop')}`;
  blocks.push({
    drop: 0,
    lines: online
      ? [keys]
      : [
          `  ${warn('○')} Waiting for a device${view.pairing ? '…' : pc.dim(' — press P for a pairing code, or reconnect a paired one')}`,
          keys,
        ],
  });

  return fitHeight(blocks, view.height).map((line) => truncate(line, view.width - 1));
}

function sessionLine(session: SessionSummary, s: AgentSnapshot): string {
  const project = s.projects.find((p) => p.id === session.projectId)?.name ?? '?';
  const kind =
    session.kind === 'desktop' ? ' desktop' : session.kind === 'voice' ? ' terminal' : '';
  const title = session.title ? `  ${pc.dim(truncate(clean(session.title), 40))}` : '';
  return `${INDENT}${pc.bold(clean(project))}${pc.dim(kind)}${title}  ${sessionState(session)}`;
}

function sessionState(session: SessionSummary): string {
  if (session.question) return warn(`asking: ${truncate(clean(session.question.text), 40)}`);
  if (session.voice?.state === 'recording') return ok('recording');
  switch (session.state) {
    case 'running':
      return ok('working');
    case 'awaiting_permission':
      return warn('waiting for approval');
    case 'error':
      return fail('error');
    default:
      return pc.dim(session.state);
  }
}

function tunnelCell(t: AgentTunnelInfo): string {
  if (t.mode === 'off') return pc.dim('off');
  if ('error' in t) return warn(`Unavailable — ${t.error}`);
  switch (t.state) {
    case 'ready':
      return `${pc.bold(t.url)} ${ok('●')}`;
    case 'connecting':
      return warn('Connecting…');
    case 'down':
      return warn(`Down — ${t.reason}; retrying in ${Math.round(t.retryInMs / 1000)}s`);
  }
}

/** Joins the blocks with blank lines, dropping optional ones until they fit `height`. */
function fitHeight(blocks: Block[], height: number): string[] {
  const kept = [...blocks];
  const size = () => kept.reduce((n, b, i) => n + b.lines.length + (i && !b.attached ? 1 : 0), 0);
  while (size() > height) {
    const worst = Math.max(...kept.map((b) => b.drop));
    if (worst === 0) break;
    kept.splice(kept.map((b) => b.drop).lastIndexOf(worst), 1);
  }
  return kept.flatMap((b, i) => (i && !b.attached ? ['', ...b.lines] : b.lines));
}

// eslint-disable-next-line no-control-regex -- colour codes
const ANSI_RE = /\x1b\[[0-9;]*m/y;

/** Cuts a line to `width` visible characters, leaving colour codes intact. */
export function truncate(line: string, width: number): string {
  let visible = 0;
  let lastStart = 0;
  let i = 0;
  while (i < line.length) {
    ANSI_RE.lastIndex = i;
    const esc = ANSI_RE.exec(line);
    if (esc) {
      i += esc[0].length;
      continue;
    }
    // One more character than fits: the last one that did becomes the ellipsis.
    if (visible === width) return `${line.slice(0, lastStart)}…\x1b[0m`;
    lastStart = i;
    visible++;
    i += line.codePointAt(i)! > 0xffff ? 2 : 1;
  }
  return line;
}

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
const MAX_KEPT_EVENTS = 50;

/**
 * Drives `renderDashboard` in the terminal's alternate screen: redraws on agent events
 * and once a second (only when the frame changed), and reads single keys.
 */
export class LiveDashboard {
  private readonly events: DashboardEvent[] = [];
  /** A code issued while running (P, `voicecode-agent pair`): shown even with devices online. */
  private requestedCode: string | undefined;
  private qr: { key: string; text?: string } | undefined;
  private lastFrame = '';
  private timer: NodeJS.Timeout | undefined;
  private devices = new Map<string, string>();
  private sessions = new Map<string, string>();
  private titles = new Map<string, string>();
  private primed = false;
  private readonly restore = () => this.stdout.write(LEAVE);
  private readonly detach: Array<() => void> = [];

  constructor(
    private readonly agent: Agent,
    private readonly setup: DashboardSetup,
    private readonly onQuit: () => void,
    private readonly stdout: NodeJS.WriteStream = process.stdout,
    private readonly stdin: NodeJS.ReadStream = process.stdin,
  ) {}

  start(): void {
    this.stdout.write(ENTER);
    process.once('exit', this.restore);
    const on: Agent['on'] = (event, fn) => {
      this.agent.on(event, fn);
      this.detach.push(() => this.agent.off(event, fn));
      return this.agent;
    };
    on('paired', (d) => this.log(`${ok('Paired')} ${clean(d.name)}`));
    on('pairingFailed', (reason, addr) =>
      this.log(`${warn('Pairing failed')} (${reason}) from ${addr}`),
    );
    on('pairingCode', (code) => {
      this.requestedCode = code.code;
      this.refresh();
    });
    on('tunnel', (t) => {
      if (t.mode === 'off' || 'error' in t || t.state === 'connecting') return this.refresh();
      this.log(`Tunnel ${tunnelCell(t)}`);
    });
    on('folderAllowed', (dir, device) =>
      this.log(`${warn('Folder allowed')} ${clean(dir)} by ${clean(device)}`),
    );
    on('approvalRequested', (request) => {
      this.titles.set(request.requestId, clean(request.title));
      this.log(`${warn('Approval asked')} ${clean(request.title)}`);
    });
    on('approvalResolved', (event) => {
      const title = this.titles.get(event.requestId) ?? event.requestId;
      this.titles.delete(event.requestId);
      const by = event.deviceName ? pc.dim(` · ${clean(event.deviceName)}`) : '';
      if (event.reason === 'user') {
        this.log(`${event.decision === 'allow' ? ok('Allowed') : fail('Denied')} ${title}${by}`);
      } else if (event.reason === 'timeout') {
        this.log(`${warn('Timed out')} ${title}`);
      } else {
        this.refresh();
      }
    });
    on('connections', () => this.refresh());

    if (this.stdin.isTTY) {
      this.stdin.setRawMode(true);
      this.stdin.setEncoding('utf8');
      this.stdin.on('data', this.onKey);
      this.stdin.resume();
    }
    this.stdout.on('resize', this.onResize);
    this.timer = setInterval(() => this.refresh(), 1_000);
    this.refresh();
  }

  /** Leaves the alternate screen and returns what happened while it was shown. */
  stop(): DashboardEvent[] {
    clearInterval(this.timer);
    for (const off of this.detach.splice(0)) off();
    this.stdout.off('resize', this.onResize);
    if (this.stdin.isTTY) {
      this.stdin.off('data', this.onKey);
      // In this order: leaving raw mode while a Windows console read is still pending
      // stalls everything written to the console afterwards (checked through ConPTY).
      this.stdin.pause();
      this.stdin.setRawMode(false);
    }
    process.off('exit', this.restore);
    this.restore();
    return [...this.events];
  }

  private readonly onKey = (data: string) => {
    for (const ch of data) {
      if (ch === 'p' || ch === 'P') this.agent.issuePairingCode();
      else if (ch === 'q' || ch === 'Q' || ch === '\u0003') this.onQuit();
    }
  };

  private readonly onResize = () => {
    this.lastFrame = '';
    this.stdout.write('\x1b[2J');
    this.refresh();
  };

  private log(text: string): void {
    this.push(text);
    this.refresh();
  }

  private push(text: string): void {
    this.events.push({ at: Date.now(), text });
    if (this.events.length > MAX_KEPT_EVENTS) this.events.shift();
  }

  /** Notes devices and sessions that came or went since the last redraw. */
  private diff(snapshot: AgentSnapshot): void {
    const devices = new Map(snapshot.devices.map((d) => [d.deviceId, clean(d.deviceName)]));
    const sessions = new Map(
      snapshot.sessions
        .filter((x) => x.state !== 'closed')
        .map((x) => [x.id, snapshot.projects.find((p) => p.id === x.projectId)?.name ?? '?']),
    );
    if (this.primed) {
      for (const [id, name] of devices)
        if (!this.devices.has(id)) this.push(`${ok('Connected')} ${name}`);
      for (const [id, name] of this.devices)
        if (!devices.has(id)) this.push(`${pc.dim('Disconnected')} ${name}`);
      for (const [id, name] of sessions) {
        if (!this.sessions.has(id)) this.push(`${ok('Session started')} in ${clean(name)}`);
      }
      for (const [id, name] of this.sessions) {
        if (!sessions.has(id)) this.push(`${pc.dim('Session ended')} in ${clean(name)}`);
      }
    }
    this.devices = devices;
    this.sessions = sessions;
    this.primed = true;
  }

  private pairingPanel(snapshot: AgentSnapshot): DashboardView['pairing'] {
    const code = snapshot.pairingCode;
    if (!code) return undefined;
    if (snapshot.devices.length && code.code !== this.requestedCode) return undefined;
    const tunnelUrl =
      snapshot.tunnel.mode !== 'off' && 'url' in snapshot.tunnel ? snapshot.tunnel.url : undefined;
    const url = `${tunnelUrl ?? snapshot.urls[0]}/#pair=${code.code}`;
    if (!this.setup.qr) return { code, url };
    if (this.qr?.key !== url) {
      const qr: { key: string; text?: string } = { key: url };
      this.qr = qr;
      qrcode.generate(url, { small: true }, (text) => {
        qr.text = text.replace(/^/gm, '  ');
        queueMicrotask(() => this.refresh());
      });
    }
    return { code, url, qr: this.qr.text };
  }

  private refresh(): void {
    const snapshot = this.agent.snapshot();
    this.diff(snapshot);
    const lines = renderDashboard({
      snapshot,
      setup: this.setup,
      events: this.events,
      pairing: this.pairingPanel(snapshot),
      now: Date.now(),
      width: this.stdout.columns || 80,
      height: this.stdout.rows || 40,
    });
    const frame = lines.map((l) => `${l}\x1b[K`).join('\n');
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.stdout.write(`\x1b[H${frame}\x1b[J`);
  }
}
