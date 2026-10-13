# VoiceCode Agent

Turn your Windows or Linux PC into a local server for **voice-controlled Claude Code** and
**full desktop mouse control** from any browser on your LAN. Open a URL on your phone, pair
it once, then talk to Claude Code, approve or reject its tool calls, and use the phone as a
trackpad. No cloud backend and no app to install.

```
 Phone / tablet / laptop browser            Your PC
 ┌───────────────────────────┐   HTTPS +   ┌──────────────────────────────────────────┐
 │ PWA: voice · approvals ·  │  WebSocket  │ voicecode-agent (CLI)                    │
 │ trackpad                  │◄───────────►│  Fastify HTTPS server · device pairing   │
 └───────────────────────────┘    (LAN)    │  WebSocket gateway ─┬─ Session manager ──┼─► Claude Agent SDK
                                           │                     └─ Input router ─────┼─► native mouse helper
                                           └──────────────────────────────────────────┘
```

## Quick start

Requires **Node.js 22.12+**, a logged-in Claude Code account (`claude` → `/login`) or an
`ANTHROPIC_API_KEY`, and a graphical desktop session.

```bash
npm install -g voicecode-agent          # once published; see "Development" to run from source
voicecode-agent init --project ./my-app # config, local CA, server certificate, diagnostics
voicecode-agent start
```

```
VoiceCode Agent  v0.1.0
  ● Running

  Platform      Windows 11 (build 26300)
  Claude Code   Claude login
  Mouse driver  Ready (win32-sendinput)
  Projects      my-app
  LAN URL       https://192.168.1.100:8443
  Pairing code  482-917  expires in 10 min
  CA SHA-256    99:89:0D:…

  Scan with your phone to open and pair:  [QR code]
```

Scan the QR code (it carries the pairing code), confirm a device name, and you're in.

### Trust the agent's certificate (once per device)

Browsers only allow the microphone on trusted HTTPS pages, so each device must trust the
agent's local certificate authority. Open `https://<pc-ip>:8443/voicecode-ca.crt` and:

- **Android**: Settings → Security → Encryption & credentials → Install a certificate →
  CA certificate → pick `voicecode-ca.crt`.
- **iPhone/iPad**: allow the profile download, then Settings → General → VPN & Device
  Management → install it, and Settings → General → About → Certificate Trust Settings →
  enable full trust for "VoiceCode Local CA".
- **Desktop browsers**: import it into the OS or browser certificate store as a trusted root.

Compare the fingerprint the device shows with the `CA SHA-256` line in the terminal.

The CA is **name-constrained**: it can only vouch for private IPv4 ranges (10/8, 172.16/12,
192.168/16, 100.64/10, loopback, link-local) and `*.local`/`localhost`. Even if its key
leaked, it could not be used to impersonate public websites to your phone.

### Windows firewall

Allow inbound connections on the agent's port once (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "VoiceCode Agent" -Direction Inbound -Protocol TCP -LocalPort 8443 -Profile Private -Action Allow
```

## Commands

| Command                                      | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `voicecode-agent init [--project <dir>]`     | Create config, CA and server certificate; run diagnostics           |
| `voicecode-agent start [--project <dir>]`    | Start the local server (`--port`, `--host`, `--no-qr`, `--verbose`) |
| `voicecode-agent pair`                       | Issue a new one-time pairing code (with QR) on the running agent    |
| `voicecode-agent devices`                    | List paired devices (● = connected)                                 |
| `voicecode-agent devices revoke <id\|all>`   | Revoke a device; it is disconnected immediately                     |
| `voicecode-agent sessions`                   | Live Claude sessions and recent saved sessions per project          |
| `voicecode-agent projects add\|remove\|list` | Manage the directories Claude may work in                           |
| `voicecode-agent doctor`                     | Diagnose Node, Claude auth, desktop session, mouse, TLS, network    |
| `voicecode-agent stop`                       | Stop the running agent                                              |

State lives in `%APPDATA%\voicecode-agent` (Windows) or `~/.config/voicecode-agent`
(Linux); override with `VOICECODE_HOME`. Logs are JSON lines in `agent.log` there.

## Using it

**Claude tab.** Pick a project, tap **New session** (or **Resume…** an earlier Claude Code
session), tap the microphone and speak. Dictation lands in the text box so you can fix
misheard words before tapping **Send** (or enable auto-send in settings). Claude's replies
and tool activity stream in. When Claude wants to run a tool that needs permission, an
approval card shows exactly what it will do — **Accept**, **Reject**, **Reject with
feedback**, or **Always allow this session**. **Stop** interrupts the current turn.

**Trackpad tab.** One finger moves the pointer (with acceleration), tap = left click,
two-finger tap = right click, three-finger tap = middle click, two fingers scroll, tap then
touch-and-drag = drag/select. L/M/R buttons can be held while dragging with another
finger. Speed, acceleration, scroll speed and natural scrolling are in settings.

Only one device controls the mouse at a time. Another device sees who has it and can
**Take control**; the lease is released when the holder leaves the trackpad, disconnects,
or is idle for two minutes, and any held buttons are released automatically.

## Security model

| Threat                                                | Mitigation                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropping / tampering on the LAN                  | TLS 1.2+ only; ECDSA P-256 certs from a per-install local CA; server cert auto-reissued when IPs change or within 30 days of expiry                                                                                                                                                                                               |
| Unpaired devices connecting                           | One-time 6-digit code, 10-minute expiry, 5 attempts then burned, 10 pairing requests/min per IP                                                                                                                                                                                                                                   |
| Stolen credential from page script (XSS)              | Device credential is an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie; strict CSP (`script-src 'self'`)                                                                                                                                                                                                                    |
| Credential theft from disk                            | Only SHA-256 hashes of 256-bit device secrets are stored; files written atomically with `0600`                                                                                                                                                                                                                                    |
| Cross-site WebSocket hijacking / CSRF / DNS rebinding | WebSocket upgrades and POSTs require `Origin` = the request's own host; `Host` must be a name in the certificate                                                                                                                                                                                                                  |
| Malformed or flooding clients                         | Every message validated with zod, 64 KB frame limit, per-connection token bucket, bounded deltas                                                                                                                                                                                                                                  |
| Claude running tools without consent                  | `permissionMode: "default"` with every prompt routed to `canUseTool`; `bypassPermissions`/`auto`/`dontAsk` cannot be configured and are reverted if project settings set them; approvals are tap-only (never by voice); unanswered approvals are denied after 15 minutes; "always allow" is limited to session-scoped allow rules |
| Claude working outside intended directories           | Sessions can only start in an allow-list of canonical (realpath) project directories managed from the PC                                                                                                                                                                                                                          |
| Stuck mouse buttons                                   | Buttons pressed under a lease are released when it ends, on disconnect, on driver exit and by the helper on EOF                                                                                                                                                                                                                   |
| Other local users driving the agent                   | Control channel is a named pipe / `0600` Unix socket plus a per-install secret                                                                                                                                                                                                                                                    |
| Exposure to the internet                              | Binds to the LAN; certificates are only valid for private addresses. Don't port-forward it.                                                                                                                                                                                                                                       |

## Platform support

| Platform      | Mouse backend                             | Notes                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 | `voicecode-input.exe` (Win32 `SendInput`) | Per-monitor DPI aware, multi-monitor, honours swapped buttons. Falls back to a PowerShell `SendInput` shim if the exe is missing. Input into apps running as Administrator is blocked by UIPI unless the agent is elevated too. |
| Linux X11     | `voicecode-input-x11` (XTest)             | Falls back to `xdotool`. Honours the X pointer mapping.                                                                                                                                                                         |
| Linux Wayland | `ydotool` (uinput)                        | Needs `ydotoold`. A RemoteDesktop portal + libei adapter is planned — see [native/linux-wayland](native/linux-wayland/README.md).                                                                                               |

The agent must run inside your logged-in graphical session. A Windows service (Session 0)
or a headless Linux daemon cannot reach the desktop; `doctor` detects this.

**Voice** uses the browser's Web Speech API (Chrome/Edge on Android and desktop, Safari on
iOS). Audio is processed by the browser/OS speech service and never reaches the agent;
only the final transcript is sent. On browsers without it, use the keyboard's dictation
key in the text box.

## Development

```bash
npm install
npm run build:native     # optional: native mouse helper (MinGW gcc/MSVC on Windows; gcc + libx11-dev libxtst-dev on Linux)
npm run build            # web client → agent bundle (apps/agent/dist)
node apps/agent/dist/cli.js start --project .
```

Live-reload loop: run the agent with `npm run dev:agent` and the web client with
`npm run dev:web`. The Vite dev server reuses the agent's certificate and proxies `/api`
and `/ws` to it (`VOICECODE_AGENT_URL`, default `https://127.0.0.1:8443`).

```bash
npm run lint && npm run typecheck && npm test
```

The test suite covers pairing and token handling, the CA (including real TLS handshakes
that exercise the name constraints), the mouse input router (lease, coalescing, button
release), the approval broker, trackpad gestures, and an end-to-end HTTPS/WebSocket test
with a fake Agent SDK `query()`.

### Repository layout

```
apps/agent/        CLI + server (TypeScript, bundled with tsup)
  src/cli/         commander commands and terminal UI
  src/server/      Fastify app, origin/cookie security, WebSocket gateway
  src/pairing/     pairing codes → device credentials, device registry
  src/claude/      Agent SDK session, approval broker, tool summaries
  src/sessions/    session manager
  src/mouse/       driver interface, helper-process & CLI drivers, input router
  src/tls/         local CA + server certificate lifecycle
  src/ipc/         local control channel used by pair/devices/sessions/stop
  src/doctor/      diagnostics
apps/web/          React PWA (Vite)
native/windows/    SendInput helper (C) + PowerShell fallback
native/linux-x11/  XTest helper (C)
native/linux-wayland/  Wayland adapter notes
packages/protocol/ shared wire protocol (zod schemas + types)
packages/security/ pairing codes, secret hashing, local CA
```

### Native helper protocol

Each helper reads one command per line on stdin and replies on stdout, so new platforms
only need a small program:

```
agent → helper   m <dx> <dy> | d <l|r|m> | u <l|r|m> | s <dx> <dy> | p | q
helper → agent   ready key=value… | pos <x> <y> | err <message>
```

`s` is in wheel units (120 = one notch, +dy scrolls down). `q` or EOF releases held
buttons and exits.

## Releasing

Releases are published to npm by the [Release workflow](.github/workflows/release.yml)
when a `v*` tag is pushed. It builds the native helpers for `win32-x64`, `linux-x64` and
`linux-arm64` (Linux on Ubuntu 22.04 for glibc compatibility), runs lint, typecheck and
tests, builds the bundle, verifies the tarball contents
(`node scripts/verify-package.mjs --require-native`), publishes with provenance and
creates a GitHub release. Versions with a pre-release suffix (`1.0.0-beta.1`) go to the
`next` dist-tag.

```bash
npm run release -- patch        # or minor | major | 0.2.0 | 0.2.0-beta.1
git push origin main v0.1.1     # the command printed by the script
```

Run the workflow manually (Actions → Release → Run workflow) for a full dry run that
ends in `npm publish --dry-run`.

**One-time npm setup.** Publishing uses
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub OIDC), so no
long-lived token is stored. A trusted publisher can only be configured for a package
that already exists, so:

1. For the first release, create a granular npm access token with publish rights and
   save it as the `NPM_TOKEN` repository secret.
2. After it is published, on npmjs.com open `voicecode-agent` → Settings → Trusted
   publishing → GitHub Actions: owner `porhong`, repository `voicode`, workflow
   `release.yml`.
3. Delete the `NPM_TOKEN` secret and revoke the token. In the package settings, set
   publishing access to "Require two-factor authentication and disallow tokens".

## Roadmap

- Wayland RemoteDesktop portal + libei helper
- Standalone executables (Node SEA) with the native helper embedded
- Optional PTY mode for attaching to an interactive `claude` terminal
- Keyboard input and text injection
