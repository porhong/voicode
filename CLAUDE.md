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
  src/cli/commands  init start (default) status pair devices sessions projects roots tunnel autostart firewall doctor cleanup stop
  src/config        config schema, project allow-list, workspace roots (folders a device may open)
  src/server        Fastify app, origin/host guard, cookie auth, WebSocket gateway
  src/claude        ClaudeSession (SDK query), ApprovalBroker (canUseTool + hook asks),
                    claude-executable (SEA download), pty-session (VoiceSession: interactive
                    claude in node-pty for /voice dictation), hook-server (loopback endpoint
                    the `hook pre-tool-use` subcommand reports tool calls to), voice-screen
  src/tunnel        cloudflared config + process supervisor (optional Cloudflare Tunnel)
  src/sessions      SessionManager (phone sessions), PcSessionWatcher (read-only view of all
                    Claude sessions on the PC via ~/.claude/sessions + transcripts)
  src/desktop       DesktopSession (a Claude Desktop session taken over), desktop-helper
                    (voicecode-desktop.ps1 over JSON lines: UI Automation), approval-hook
                    (the PermissionRequest hook `desktop enable` installs)
  src/mouse         InputRouter (lease, coalescing), helper-process / command drivers
  src/voice         MicRouter (phone mic lease, PCM frames) → virtual microphone drivers
                    (Windows waveOut helper into VB-CABLE, Linux PipeWire null sink)
  src/storage       disposable files (old runtimes/Claude Code downloads, agent.log.1, stale
                    temp files): scan + cleanup, StorageJanitor (auto cleanup over a limit); AttachmentStore
                    (images uploaded from the phone, 24 h)
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
  - Modes that skip approvals (`bypassPermissions`, `auto`, `dontAsk`) are off unless the
    owner runs `voicecode-agent modes allow-unsafe` on the PC (a deliberate decision of
    2026-10-15); a phone can never enable them, `modes safe-only` drops running sessions
    back to manual, and unsafe modes from project settings are always reverted. While
    off, the PreToolUse hook keeps asking the phone even if a terminal is put in bypass.
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
- v0.1.0 is released: `@anantbot/voicecode-agent@0.1.0` was published by hand.
- v0.1.1 (2026-10-15) was released entirely by the tag-triggered workflow: npm trusted
  publishing with a provenance statement (`latest`), 7 native helpers, and the GitHub
  release with the Windows x64 and Linux x64/arm64 standalone archives, `SHA256SUMS.txt`
  and build attestations. Cut it with `npm run release -- <version>` from a clean tree
  (the script refuses untracked files too).
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
    on other versions (`voice-screen.ts` is lenient).
  - Take control (2026-10-14): `pc.session.control` attaches a `VoiceSession` to a Claude
    Code the user runs in a terminal (Windows only: `native/windows/voicecode-console.c`
    does `AttachConsole(pid)` + `WriteConsoleInput` for keys and reads the screen buffer;
    `console-attach.ts` turns the polled screen into full repaints for the headless xterm).
    Registry status `waiting` maps to `awaiting_permission` and the phone opens the
    terminal view. Verified by attaching to a hidden conhost process and to a
    ConPTY-hosted one (keys arrived, screen read); a real `claude` under control is not
    verified yet.
  - Verified against a real Claude Code 2.1.299 in the agent's pty (VB-CABLE installed on
    the dev PC on 2026-10-14): the folder safety check (default "No, exit") is detected as
    a dialog and answered with ↓ Enter from the terminal view; `--settings voice` does not
    show a footer hint on this version, so the session types `/voice tap` itself once the
    prompt is empty; push-to-talk gives `starting → recording → finalizing → idle` and, with
    no phone audio, "No audio detected from microphone" is surfaced as a voice error. An
    enclosing Claude Code's `CLAUDE_CODE_CHILD_SESSION` marker is stripped from the child
    env (it switches transcript saving off).
  - Model switching (2026-10-15): `claude.model.set` / `claude.models`, and a `model` on
    session start. SDK sessions use `setModel()` / `supportedModels()`; terminal sessions
    type `/model <name>` (prompt must be empty, not while working) and read "Set model to
    …" or "Model '…' not found" back. Note: Claude Code's `/model` persists the choice to
    `~/.claude/settings.json` (the picker warns); probes on the dev PC must leave the
    owner's `"model": "opus"` in place. Verified on Claude Code 2.1.299 (Haiku → Opus).
  - Permission modes (2026-10-15): `claude.mode.set`; sessions report `permissionMode`
    and the `modes` they may switch to. SDK sessions use `setPermissionMode` (bypass needs
    `allowDangerouslySkipPermissions`, given only when unsafe modes are allowed at start)
    and follow `system/status` mode changes. Terminal sessions press Shift+Tab until the
    footer shows the mode (`readPermissionMode`; strings checked on Claude Code 2.1.299,
    "don't ask" is not in the cycle); taken-over terminals get Shift+Tab through the
    console helper. Verified on a real hosted Claude Code: plan, bypass, accept edits,
    manual.
  - Phase 3: the standalone build embeds the `@lydell/node-pty-<target>` package under
    `node-pty/` and `loadPtySpawn()` loads it from the extracted runtime (`doctor` row
    "Claude Code terminal", asserted by `smoke-sea.mjs`); the xterm packages are imported
    from their `.mjs` builds (`src/types/xterm-esm.d.ts`). On Windows the audio helper's
    `--set-default-capture` (undocumented `IPolicyConfig`) makes "CABLE Output" the
    default input while a phone streams and restores the previous device; verified on this
    Windows 11 PC by switching the built-in microphone to itself.

- Cleanup (2026-10-15): Settings → Storage on the phone (`storage.info/cleanup/settings`)
  and `voicecode-agent cleanup [--dry-run]` / `cleanup auto on|off --limit <MB>` remove
  only an allow-list of file shapes (`storage/disposable.ts`); the versions in use are
  kept (unknown in the npm build → the newest is kept). Auto cleanup (config `cleanup`,
  default on, 250 MB) runs 2 min after start and every 6 h; the live log now rotates
  every 5 min too. Verified with unit/integration tests, the built CLI on a temp home and
  `ui-demo.ts` screenshots (dark and light); not on a real standalone install yet.

- Images from the phone (2026-10-16): the composer's paperclip picks photos (camera or
  library), `lib/image.ts` shrinks them to 1568 px (JPEG 0.85, small PNGs kept), and
  `useAttachments` uploads each on pick to `POST /api/attachments` (raw body, type
  sniffed from the bytes, 10 MB, `storage/attachments.ts`: random ids, 24 h, category
  `attachments` in cleanup). `claude.prompt.attachments` carries the ids. SDK sessions
  get base64 image blocks before the text; terminal sessions get `Attached image: <path>`
  lines (not `@path`: its menu swallows Enter) and `--add-dir <attachments>`. Claude Code
  2.1.299 turns the path into `[Image #1]`; `withoutImageMentions()` cleans the
  transcript. Verified: unit + integration tests, headless Chrome against `ui-demo.ts`
  (6 MB photo → 156 KB JPEG, error state, image-only prompt, dark and light), and a real
  Haiku terminal session that read the image without a permission prompt. Not verified:
  a real phone's camera and HEIC photos (decoding is left to the browser). The deck has
  the paperclip in its display bar (count badge; `ComposerHandle.attach/sendPrompt`, so
  macro keys and the joystick send the waiting images too); checked in headless Chrome at
  390 and 360 px, dark and light, normal and full screen.

- Claude Desktop control (2026-10-16), Windows: `pc.session.control` on a session whose
  registry entry has `entrypoint: "claude-desktop"` (`PcSession.app`) creates a
  `DesktopSession` (`kind: 'desktop'`). Approvals: `voicecode-agent desktop enable` adds a
  `PermissionRequest` hook (`hook permission-request`) to `~/.claude/settings.json`; Claude
  Code runs it alongside Desktop's dialog ("whichever decides first applies"), the hook
  reads the agent's loopback endpoint from `<VOICECODE_HOME>/hook-endpoint.json` and gets
  the phone's answer; a request answered on the PC is withdrawn when its tool call gets a
  result in the transcript. Prompts, Stop, mode and model go through Desktop's window
  (`native/windows/voicecode-desktop.ps1`, UI Automation; the open session is found by the
  page title "<title> - Claude Code", sessions by the transcript's `custom-title`). The
  window is raised without activation before acting (Chromium stops rendering a covered
  or minimized window, and its tree goes stale); while minimized, working/idle comes from
  the transcript (`end_turn`, `stop_hook_summary`). Pressing Desktop's approval buttons
  through UI Automation was tried first and is unreliable when the window isn't active.
  Verified against Claude Desktop 1.30096 (Claude Code 2.1.229) with Desktop minimized:
  hook allow ran the command, deny blocked it; model switch confirms Desktop's "Switch
  model?" dialog. Hooks reload in running sessions. Not verified: the phone UI against a
  real Desktop session (only typecheck + unit tests), Desktop v2.x labels.

- Terminal menus as questions (2026-10-17): `readMenu()` (`voice-screen.ts`) reads Claude
  Code's own menus off the screen — the cursor `❯` is indented (the input prompt's isn't),
  options are numbered or followed by "Enter to confirm / Esc to cancel", the question is
  the last line ending in "?" (else the asking sentence of a paragraph). `VoiceSession`
  publishes it as `SessionSummary.question`; `claude.question.answer {index, option}`
  moves the cursor and presses Enter only if that option is still there. Each question is
  announced once (repaints no longer repeat it). The second Enter after a typed prompt is
  never pressed while a menu is open (it would pick "Yes"). Parser checked against
  screens captured from Claude Code 2.1.299 (trust check, permission prompt); the card in
  headless Chrome against `ui-demo.ts` (whose fake terminal opens a menu for "deploy"),
  chat and deck, dark and light. Not tried on a real phone or with AskUserQuestion.

- Voice + images (2026-10-17): hosted voice sessions now dictate in **hold** mode, given
  by `--settings` only (typing `/voice <mode>` saves it to the user's settings, so it is no
  longer typed there). Push-to-talk repeats Space every 30 ms while the phone holds (like
  key-repeat), keeps it up 600 ms after release for the last audio, and presses Enter once
  the transcript has landed and the prompt stayed unchanged for 2 s (never into a menu or
  an empty prompt). Images sent with the press (`voice.ptt.attachments`) are pasted first
  and become Claude Code attachments (`[Image #1]`); the transcript lands after them, so
  one prompt carries both. Tap mode can't: it needs an empty prompt to start and drops the
  transcript when the prompt is edited while recording (checked); taken-over terminals keep
  the user's mode, and in tap mode images follow as a second prompt. Dictation counts as
  ready only once the prompt is on screen. Menus are answered only after 600 ms on screen,
  one arrow per write (a half-read arrow counts as Esc). Verified with Claude Code 2.1.299,
  Windows text-to-speech played into VB-CABLE, and an image: one prompt "What color is the
  attached image? …" with the image, answered "Blue"; the user's settings file unchanged.

- Terminal dashboard (2026-10-18): on an interactive terminal `start` draws a live screen
  (`cli/dashboard.ts`, alternate screen, redrawn on agent events and each second only
  when the frame changed) from `Agent.snapshot()`. With no device online it shows the
  setup details, the code and its QR; once one is, devices, sessions, waiting approvals,
  PC sessions, mouse/mic holders, tunnel and recent events, and the QR only after P (or
  `voicecode-agent pair`). Short windows drop hints, events and details before the QR.
  `--no-dashboard`, `--verbose` and non-TTY runs keep the scrolling log. Verified in a
  ConPTY (node-pty + headless xterm) with a fake device paired over HTTP/WebSocket:
  waiting → connected → P → 80×24 → disconnected → Q. Stdin must be paused before
  `setRawMode(false)` on Windows, or later console output stalls. Not tried in Linux
  terminals.

Not verified yet:

- A real phone: certificate install, microphone, touch.
- The Wayland helper on a real desktop (it is only compile-checked).
- PC session discovery reads Claude Code internals (`~/.claude/sessions/<pid>.json`,
  transcript JSONL); checked against Claude Code 2.1.299 only. Parsing is lenient.
- Cloudflare Tunnel: quick mode was checked end to end through Cloudflare (pairing,
  cookie, WebSocket). `tunnel setup` was run for real on 2026-10-18 (cloudflared
  2026.10.1, a fresh account: `tunnel list --output json` prints `null` there): tunnel
  created, DNS routed, the PWA served over the public host name; pairing through it was
  not tried. `tunnel token` is still only checked by its generated config.
- One tunnel per PC (2026-10-19): two PCs on one tunnel are replicas, and Cloudflare
  sends each request to either PC whatever its host name (the old fixed default name
  `voicecode` caused this). `tunnel setup` now defaults to `voicecode-<PC name>`
  (`defaultTunnelName`) and saves `tunnelName`. It refuses an existing tunnel that has
  connectors when this PC's config and credentials don't name it, and moves this PC's
  own host name to its new tunnel with `--overwrite-dns`. The agent compares
  `tunnel info --output json` connectors with its own "Generated Connector ID" on every
  connect and every 15 min, and reports `sharedWith` (start log, dashboard, `status`).
  `tunnel status` shows a "Running on" row. Verified: `tunnel status` on the dev PC found
  the second PC on the shared `voicecode` tunnel, and a real quick tunnel's log has the
  connector line. The `setup` migration itself was not run, since it changes the owner's
  DNS.

Next candidates, in rough priority:

1. Keyboard input and text injection.
2. PTY mode for attaching to an interactive `claude`.
3. Code-signing the Windows `.exe`.
