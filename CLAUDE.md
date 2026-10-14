# CLAUDE.md

Working notes for Claude Code on this repository. Machine setup and test commands are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); product docs and the security model are in the
[README](README.md).

## What this is

`voicecode-agent`: a CLI for Windows and Linux that serves a React PWA over LAN
HTTPS/WebSocket. A paired phone drives Claude Code through `@anthropic-ai/claude-agent-sdk`
(every tool call is approved or rejected on the phone) and uses the phone as a trackpad
through native input helpers. Shipped on npm as `@anantbot/voicecode-agent` (command
`voicecode-agent`; workspace name for `-w`) and as standalone executables (Node SEA).

## Layout

```
packages/protocol   zod wire schemas + types shared by agent and web (PROTOCOL_VERSION)
packages/security   pairing codes, secret hashing, local CA (@peculiar/x509)
apps/agent          CLI + server, bundled with tsup (npm) or esbuild (SEA)
  src/cli/commands  init start (default) status pair devices sessions projects roots tunnel autostart firewall doctor stop
  src/config        config schema, project allow-list, workspace roots (folders a device may open)
  src/server        Fastify app, origin/host guard, cookie auth, WebSocket gateway
  src/claude        ClaudeSession (SDK query), ApprovalBroker (canUseTool + hook asks),
                    claude-executable (SEA download), pty-session (VoiceSession: interactive
                    claude in node-pty for /voice dictation), hook-server (loopback endpoint
                    the `hook pre-tool-use` subcommand reports tool calls to), voice-screen
  src/tunnel        cloudflared config + process supervisor (optional Cloudflare Tunnel)
  src/sessions      SessionManager (phone sessions), PcSessionWatcher (read-only view of all
                    Claude sessions on the PC via ~/.claude/sessions + transcripts)
  src/mouse         InputRouter (lease, coalescing), helper-process / command drivers
  src/voice         MicRouter (phone mic lease, PCM frames) → virtual microphone drivers
                    (Windows waveOut helper into VB-CABLE, Linux PipeWire null sink)
  src/util          standalone.ts (SEA assets), tar.ts, logger, network
  scripts           copy-web, prepack, build-sea, smoke-sea, ui-demo (fake Claude for UI work)
apps/web            React PWA (Vite): Pair page, Claude tab, Trackpad tab, settings
native/             C helpers: windows (SendInput; audio-out: waveOut), linux-x11 (XTest),
                    linux-wayland (portal + libei)
scripts/            build-native, verify-package, release, e2e-browser, ui-screenshots
```

## Commands

```bash
npm run format:check && npm run lint && npm run typecheck && npm test   # what CI checks
npm run build                    # web, then agent → apps/agent/dist
npm run verify:package           # npm tarball contents
npm run build:sea && node apps/agent/scripts/smoke-sea.mjs   # standalone binary
npm run e2e -- <url> <code>      # real browser + real Claude against a running agent
```

## Conventions

- Commit straight to `main` and push; CI must stay green (`gh run list`). End commit
  messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The owner has authorised autonomous work: decide, implement, test, commit and push
  without asking. Never publish to npm or handle npm tokens; releases are cut by pushing a
  tag (`npm run release -- <version>`). The release workflow skips `npm publish` when the
  version is already on npm (0.1.0 was published by hand) but still attaches the
  standalone binaries to the GitHub release.
- Real Claude runs cost money. Use the fake `queryFn` in tests; use `npm run e2e` or small
  real prompts only to verify behaviour the fakes can't, and keep them short.
- Security invariants (don't weaken without a deliberate decision):
  - Never use `bypassPermissions`; unsafe modes from settings are reverted.
  - Approvals show complete tool input; incomplete details can only be rejected.
  - Pairing codes are single use, expire after 10 minutes and allow 5 attempts.
  - Device secrets are stored hashed; HttpOnly `__Host-` cookie.
  - Every HTTP and WebSocket request passes the origin/host guard.
  - Certificates are limited by name constraints to private ranges.
  - Cloudflare Tunnel is opt-in. cloudflared verifies the origin against the local CA
    (never `--no-tls-verify`), and the tunnel token goes by file, never argv.
- Untrusted text (device names, tool input) is stripped of control/format characters
  before reaching a terminal (`clean()` in `src/cli/ui.ts`).
- Match the surrounding style: explanatory doc comments on non-obvious decisions, small
  modules, zod at the boundaries. Prettier + typescript-eslint enforce the rest.

## Gotchas

- TypeScript is pinned to `~6.0` for typescript-eslint compatibility.
- `tsup.config.ts` sets `removeNodeProtocol: false`: `node:sea` has no bare name and the
  npm bundle crashes without it.
- The SEA bundle is CommonJS (Node 24 SEA can't run ESM mains); `import.meta.url` is
  shimmed in `build-sea.mjs`. Standalone builds receive `__CLAUDE_CODE_PACKAGE__` (the
  pinned npm URL + sha512 from `package-lock.json`); the npm build leaves it undefined
  and lets the SDK find its own binary.
- Bumping `@anthropic-ai/claude-agent-sdk` changes the Claude Code version standalone users
  download; `build-sea.mjs` refuses mismatched platform packages in the lockfile.
- `packageRoot()` (`src/util/version.ts`) is the single way to find bundled assets; in
  SEA mode it points at the extracted runtime cache.
- Windows: the agent must run in the user's desktop session (not a service), and input
  into elevated windows is blocked by UIPI.
- Logs: `<VOICECODE_HOME>/agent.log` (JSON, rotated at 10 MB). `VOICECODE_DEBUG=1` prints
  CLI stack traces.

## Status (2026-10-14)

Done and verified:

- Feature scope of the original plan is complete, including standalone executables.
- CI is green on all jobs.
- The release workflow dry run passes, with all 5 native helpers and 3 standalone
  binaries.
- v0.1.0 is released: `@anantbot/voicecode-agent@0.1.0` is on npm (`latest`), and the
  GitHub release has the Windows x64 and Linux x64/arm64 standalone archives with
  `SHA256SUMS.txt` and build attestations.
- Real Claude flows were checked in headless Chrome.
- Mouse movement was checked pixel-exact on Windows.
- Mobile UX pass on the web client (compact session header + sheet, one-button composer,
  smart scroll, keyboard-safe height, WCAG AA contrast, 44px targets) checked with
  `ui-demo.ts` screenshots at 390/360 px and landscape, dark and light.
- Deck layout for the Claude tab (Codex Micro style: programmable keys, scroll wheel, joystick,
  push-to-talk; `components/Deck*.tsx`, `hooks/useDeck.ts`) checked the same way;
  real-phone touch feel (wheel, joystick, hold-to-talk) is not verified yet. Redrawn flat
  on glass with a state-coloured light, a full-screen mode (conversation hidden, wheel
  pages replies on the display) and an orientation lock (`hooks/useOrientationLock.ts`);
  all four portrait/landscape × full/normal layouts screenshotted dark and light. The
  lock itself only works on Android (installed or fullscreen) and was not tried on a
  phone.
- Global use: bare `voicecode-agent` starts from any folder and sets up on first run
  (asks for a workspace folder on a TTY). Workspace roots let the phone browse and open
  any non-hidden folder inside them (`config/workspace-roots.ts`, `FolderSheet.tsx`);
  paths are realpath'd and checked against the roots on the agent. Verified with the
  CLI from a temp folder and the UI demo; the interactive prompt itself was not driven
  in a test.

- Claude Code dictation bridge (2026-10-14), Settings → Voice → Dictation → Claude Code:
  - Phase 1: the phone streams raw 16 kHz PCM (binary WebSocket frames under a
    `voice.mic` lease, PROTOCOL_VERSION 4) and the agent plays it into a virtual
    microphone so Claude Code's `/voice` on the PC can record it. Windows helper
    `voicecode-audio-out.exe` (waveOut → "CABLE Input") was built and played a test tone
    here; `doctor` reports the cable, the default input and the claude.ai sign-in.
  - Phase 2: `voice.session.start` runs `claude --session-id … --settings {voice tap,
PreToolUse hook}` in a pty (`@lydell/node-pty`, prebuilt binaries) as a `VoiceSession`
    (`kind: 'voice'` in SessionSummary). `voice.ptt` taps Space on press, waits for
    `● REC` on an `@xterm/headless` screen, and taps again 600 ms after release; the
    transcript is tailed from Claude Code's JSONL; tool calls reach the phone through
    `hook-server.ts` + the hidden `hook pre-tool-use` subcommand (reads pass through).
    `terminal.subscribe/data/input` stream the raw CLI to an xterm.js view on the phone
    (CSP allows inline `<style>` elements for it).
  - Verified: unit + integration tests with a fake pty; headless Chrome with a fake
    microphone against `ui-demo.ts` (which fakes the Claude Code pty): session start,
    REC on press, send on release, terminal keys. Not verified: a real `claude` in the
    pty (needs VB-CABLE here), a real phone, the PipeWire driver, Claude Code TUI strings
    on other versions (`voice-screen.ts` is lenient). Phase 3 (SEA packaging of node-pty
    and the xterm packages, Windows default-device switching) is still open; the plan is
    in `~/.claude/plans/the-voice-prompt-on-streamed-sunrise.md`.

Not verified yet:

- A real phone: certificate install, microphone, touch.
- The Wayland helper on a real desktop (it is only compile-checked).
- A tag-triggered `npm publish --provenance` from CI: 0.1.0 was published by hand, so
  that path (trusted publishing) runs for the first time on the next release.
- PC session discovery reads Claude Code internals (`~/.claude/sessions/<pid>.json`,
  transcript JSONL); checked against Claude Code 2.1.299 only. Parsing is lenient.
- Cloudflare Tunnel: quick mode was checked end to end through Cloudflare (pairing,
  cookie, WebSocket). `tunnel setup` and `tunnel token` need a Cloudflare account and a
  domain, so only their generated ingress config was validated with cloudflared.

Next candidates, in rough priority:

1. Keyboard input and text injection.
2. PTY mode for attaching to an interactive `claude`.
3. Code-signing the Windows `.exe`.
