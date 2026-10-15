// Drives a real Claude Code in a pty the way a voice session does, without a phone:
// starts it in a temp folder (or the folder given), answers the folder safety check with
// "Yes", waits until dictation is on, presses push-to-talk, prints what the screen
// shows, releases, and exits. No prompt is sent, so no tokens are used; with no audio on
// the virtual microphone Claude Code reports "No audio detected", which is expected.
//
//   npx tsx apps/agent/scripts/probe-voice.ts [folder]
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/config/config.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { silentLogger } from '../src/util/logger.js';

const folderArg = process.argv[2];
const home = folderArg
  ? path.resolve(folderArg)
  : await mkdtemp(path.join(os.tmpdir(), 'voicecode-probe-'));
const config = ConfigSchema.parse({
  version: 1,
  projects: [{ id: 'p', name: 'probe', path: home }],
});
const manager = new SessionManager(config, silentLogger());
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
manager.on('session', (s) => log('state', s.state, 'voice', s.voice?.state, s.voice?.detail ?? ''));
manager.on('event', (_id, r) => r.event.kind === 'status' && log('status:', r.event.message));

/**
 * The terminal's screen as plain lines. The snapshot encodes runs of spaces as cursor
 * moves (ESC [ n C), so those become spaces again before other escapes are removed.
 */
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD = /\x1b\[(\d*)C/g;
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const lines = () =>
  session
    .snapshot()
    .data.replace(CURSOR_FORWARD, (_, n: string) => ' '.repeat(Number(n || 1)))
    .replace(ESCAPES, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
const plain = () => lines().slice(-12).join('\n');
/** The menu row the cursor is on. */
const selected = () => lines().find((l) => l.includes('❯')) ?? '';

const session = await manager.startVoice('p');
const deadline = Date.now() + 60_000;
let answered = false;
while (Date.now() < deadline && session.summary().voice?.state !== 'idle') {
  await sleep(500);
  if (!answered && /safety check|trust this folder/i.test(lines().join('\n'))) {
    // The default option is "No, exit": move to "Yes, I trust this folder" first.
    for (let i = 0; i < 5 && !/Yes/.test(selected()); i++) {
      session.writeInput('\x1b[B');
      await sleep(600);
    }
    log('safety check: choosing', JSON.stringify(selected().trim()));
    session.writeInput('\r');
    answered = true;
  }
}
log('screen before ptt:\n' + plain());
log('voice state', session.summary().voice?.state);

await session.pressPtt(true, 'probe');
log('after press: voice', session.summary().voice?.state, session.summary().voice?.detail ?? '');
log('screen while recording:\n' + plain());
await sleep(1500);
await session.pressPtt(false, 'probe');
await sleep(2500);
log('after release: voice', session.summary().voice?.state, session.summary().voice?.detail ?? '');
log('screen after release:\n' + plain());

session.close();
await sleep(3500);
manager.closeAll();
if (!folderArg) await rm(home, { recursive: true, force: true }).catch(() => undefined);
log('done');
process.exit(0);
