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

Requires a logged-in Claude Code account (`claude` → `/login`) or an
`ANTHROPIC_API_KEY`, and a graphical desktop session. Install it either way:

- **Standalone executable** (no Node.js needed): download the archive for your platform
  from [GitHub Releases](https://github.com/porhong/voicode/releases) —
  `voicecode-agent-<version>-windows-x64.zip`, `-linux-x64.tar.gz` or
  `-linux-arm64.tar.gz` — and extract `voicecode-agent` somewhere on your `PATH`. See
  [Standalone executables](#standalone-executables).
- **npm** (Node.js 22.12+): `npm install -g @anantbot/voicecode-agent` (installs the `voicecode-agent` command)

Then run it from any terminal, in any folder:

```bash
voicecode-agent
```

Nothing is set up per folder. On first run it creates its settings, local CA and server
certificate in your per-user config folder (`%APPDATA%\voicecode-agent` on Windows,
`~/.config/voicecode-agent` on Linux), then asks once where you keep your projects:

```
  Where do you keep your projects?
  Claude can then be started in any folder inside it from your phone. Every tool
  call still needs your approval there. Leave empty to skip for now.
  Workspace folder (~/code):
```

That becomes a **workspace folder**: on the phone, **Open a folder on the PC…** browses it
and starts Claude in any project inside it (hidden folders excluded). Pass `--root <dir>`
to skip the question, or `--project <dir>` to allow just one folder; `voicecode-agent init`
does the same setup without starting the server.

```
VoiceCode Agent  v0.1.0
  ● Running

  Platform      Windows 11 (build 26300)
  Claude Code   Claude login
  Mouse driver  Ready (win32-sendinput)
  Projects      my-app
  Workspace     C:\Users\you\code
  LAN URL       https://192.168.1.100:8443
  Pairing code  482-917  expires in 10 min
  CA SHA-256    99:89:0D:…

  Scan with your phone to open and pair:  [QR code]
```

Scan the QR code (it carries the pairing code), confirm a device name, and you're in.

### Standalone executables

Each executable is a [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html)
with the web client and the native mouse helpers embedded; they are unpacked to a cache
directory on first run (`%LOCALAPPDATA%\voicecode-agent` on Windows,
`~/.cache/voicecode-agent` on Linux, or `VOICECODE_CACHE_DIR`).

Claude Code itself (~250 MB) is not embedded. On first `init` or `start` the agent
downloads the exact version it was built and tested with from the npm registry
(`@anthropic-ai/claude-agent-sdk-<platform>`) and verifies it against the SHA-512
integrity hash recorded at build time. Offline, it falls back to a native `claude` on your
`PATH`. To use a specific binary instead, set `VOICECODE_CLAUDE_PATH`.

The release page lists `SHA256SUMS.txt`, and every archive carries a signed build
provenance attestation:

```bash
gh attestation verify voicecode-agent-0.1.0-linux-x64.tar.gz --repo porhong/voicode
```

The Windows executable is not Authenticode-signed, so SmartScreen may warn the first time
you run it (More info → Run anyway).

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

### Or skip the certificate: Cloudflare Tunnel (optional)

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
gives the agent a public HTTPS URL with a certificate every phone already trusts, so no
device needs the CA. It also works away from your Wi-Fi. Install `cloudflared` first
(`winget install --id Cloudflare.cloudflared` on Windows, or your
[Linux package](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
Then pick one of these:

```bash
voicecode-agent tunnel quick                    # free *.trycloudflare.com URL, no account
voicecode-agent tunnel setup code.example.com   # your own domain (must use Cloudflare DNS)
voicecode-agent tunnel token code.example.com   # a tunnel made in the Zero Trust dashboard
voicecode-agent start                           # prints the Tunnel URL and a QR code for it
```

- **Quick tunnels** need no account, but the URL changes on every start. Because the
  device cookie belongs to that URL, devices have to pair again each time. For a quick
  test without changing the config, use `voicecode-agent start --tunnel`.
- **`tunnel setup <hostname>`** opens a Cloudflare login the first time. It then creates
  a tunnel named `voicecode` (change this with `--name`) and adds a DNS record for the
  host name. It won't replace an existing DNS record unless you pass `--overwrite-dns`.
  The tunnel credentials are saved in `<state dir>/tunnel/credentials.json`. The URL
  stays the same, so devices stay paired.
- **`tunnel token <hostname>`** reads the token from stdin, or from a hidden prompt. It
  stores the token in `<state dir>/tunnel/token`, and the agent never passes it on the
  command line. In the dashboard, point the public hostname at the printed service URL
  and CA Pool path, and leave "No TLS Verify" off.
- `voicecode-agent tunnel` shows the current setup. `tunnel off` switches back to LAN
  only, and `start --no-tunnel` skips the tunnel for one run.

The agent starts `cloudflared` and supervises it, restarting it with backoff if it exits.
`cloudflared` checks the agent's certificate against the local CA instead of turning off
TLS verification. A tunnel that can't start never stops the agent; the LAN URL keeps
working.

> **The tunnel makes the pairing page reachable from the internet.** Devices still need
> a one-time code from your PC, and codes still expire and lock out after 5 wrong tries.
> But only share codes with your own devices, and consider putting a
> [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)
> login in front of your own domain. To accept connections only through the tunnel, bind
> the agent to loopback with `voicecode-agent start --host 127.0.0.1`.

### Windows firewall

Allow inbound connections once — this opens a Windows admin prompt and adds a rule for
the agent's port on Private and Domain networks:

```bash
voicecode-agent firewall
```

If your Wi-Fi is marked as a **Public** network, Windows still blocks it; `doctor` warns
about this. Set your home or office network to Private in Settings → Network & internet.

### Start at login (optional)

```bash
voicecode-agent autostart enable   # Windows Startup folder / Linux XDG autostart, no admin needed
```

The agent then starts hidden in your desktop session at every login and logs to
`agent.log`. Use `voicecode-agent status` to see its URL and `voicecode-agent pair` for a
pairing code.

## Commands

| Command                                | Purpose                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `voicecode-agent`                      | Same as `start`; works from any folder and sets everything up on first run                                    |
| `voicecode-agent init [--root <dir>]`  | Create config, CA and server certificate; run diagnostics (`--project <dir>` too)                             |
| `voicecode-agent start [--root <dir>]` | Start the local server (`--project`, `--port`, `--host`, `--no-qr`, `--verbose`, `--tunnel`, `--no-tunnel`)   |
| `voicecode-agent roots add <dir>`      | Add a workspace folder whose projects can be opened from a device; `roots remove` / `roots list` too          |
| `voicecode-agent status`               | Running or not, URL, uptime, connected clients, mouse holder, sessions                                        |
| `voicecode-agent pair`                 | Issue a new one-time pairing code (with QR) on the running agent                                              |
| `voicecode-agent devices`              | List paired devices (● = connected)                                                                           |
| `voicecode-agent devices revoke <id>`  | Revoke a device by id prefix (or `all`); it is disconnected immediately                                       |
| `voicecode-agent sessions`             | Live Claude sessions and recent saved sessions per project                                                    |
| `voicecode-agent projects add <dir>`   | Allow a directory for Claude; `projects remove` / `projects list` too. Applies to a running agent immediately |
| `voicecode-agent autostart enable`     | Start the agent at login; `autostart disable` / `autostart status` too                                        |
| `voicecode-agent tunnel`               | Cloudflare Tunnel: `tunnel quick`, `tunnel setup <hostname>`, `tunnel token <hostname>`, `tunnel off`         |
| `voicecode-agent firewall`             | Allow the agent's port through Windows Defender Firewall                                                      |
| `voicecode-agent doctor`               | Diagnose Node, Claude auth, desktop session, mouse, TLS, firewall, network                                    |
| `voicecode-agent stop`                 | Stop the running agent                                                                                        |

State lives in `%APPDATA%\voicecode-agent` (Windows) or `~/.config/voicecode-agent`
(Linux); override with `VOICECODE_HOME`. Logs are JSON lines in `agent.log` there
(rotated to `agent.log.1` when it passes 10 MB).

## Using it

**Claude tab.** Pick a project, tap **New session** (or **Resume…** an earlier Claude Code
session), tap the microphone and speak. Dictation lands in the text box so you can fix
misheard words before tapping **Send** (or enable auto-send in settings). Claude's replies
and tool activity stream in. When Claude wants to run a tool that needs permission, an
approval card shows exactly what it will do — **Accept**, **Reject**, **Reject with
feedback**, or **Always allow this session**. **Stop** interrupts the current turn. For file edits, **Allow all edits this session** switches the
session to auto-accept edits (commands still ask). Turn on approval notifications in
settings to get a system notification when Claude is waiting while you're in another
app.

**Deck layout.** The button next to Settings (or **Settings → Claude layout**) switches
the Claude tab from a chat to a deck: a macro pad modelled on Work Louder's Codex Micro,
shown under a shorter conversation (beside it in landscape). Six programmable keys and a
four-way joystick send preset or custom prompts (push the stick and release to fire; the
display names what it will do first). Swipe the scroll wheel (a finger-wide strip, like a
mouse wheel; flick it to let it spin on) to scroll the conversation and tap it to jump to
the latest output. Command keys **Stop**, **Accept**, **Reject** and **New**
work on the session on screen; Accept and Reject answer the approval card shown above the
deck, which still carries the full tool input. Hold the wide mic key to talk and release to
send. The sliders button on the deck opens the editor: pick a layout pack, or give any key
or joystick push its own label, icon and prompt, optionally put in the box for review
instead of sent. Layouts are stored per device.

The deck is a flat glass panel lit from behind by the session's state, and the display
spells the state out too: cyan when ready, the accent colour drifting while Claude works,
amber pulsing for an approval, a green bloom when done, red after an error and violet while
you talk. The expand button on the display hides the conversation so the deck fills the
screen; the display then shows Claude's latest reply, and swiping the wheel pages through
earlier ones. Approval cards still appear above the deck in full-screen mode. The rotate
button locks the screen to portrait or landscape where the browser allows it: installed
apps and fullscreen tabs on Android can lock rotation, but iOS can't, so the deck says so.

**Every Claude session on the PC.** The sessions sheet (tap the session title) also lists
Claude Code sessions running elsewhere on the PC, such as in a terminal, with their status
(working, idle, needs input). Tap one to follow it live, read-only. Once it's idle, **Continue on
phone** resumes it as a copy that you drive from the phone, with every tool call approved there.
The terminal keeps its own copy. A folder that isn't allow-listed yet is added only after you
confirm on the phone, and the PC terminal logs it. Wherever you are in the app, a toast tells you
when a task finishes in any other session, on the phone or the PC; tap it to jump there. The agent
only reads Claude Code's own session files (`~/.claude/sessions` and `~/.claude/projects`, or
`CLAUDE_CONFIG_DIR`) for this.

**Trackpad tab.** One finger moves the pointer (with acceleration), tap = left click,
two-finger tap = right click, three-finger tap = middle click, two fingers scroll, tap then
touch-and-drag = drag/select. L/M/R buttons can be held while dragging with another
finger. Speed, acceleration, scroll speed and natural scrolling are in settings.

Only one device controls the mouse at a time. Another device sees who has it and can
**Take control**; the lease is released when the holder leaves the trackpad, disconnects,
or is idle for two minutes, and any held buttons are released automatically.

## Security model

| Threat                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eavesdropping / tampering on the LAN                  | TLS 1.2+ only; ECDSA P-256 certs from a per-install local CA limited to TLS server auth and private names; server cert auto-reissued when IPs change or within 30 days of expiry                                                                                                                                                                                                                                                                                      |
| Unpaired devices connecting                           | One-time 6-digit code, 10-minute expiry, 5 attempts then burned, 10 pairing requests/min per IP                                                                                                                                                                                                                                                                                                                                                                       |
| Stolen credential from page script (XSS)              | Device credential is an `HttpOnly; Secure; SameSite=Strict` `__Host-` cookie; strict CSP (`script-src 'self'`)                                                                                                                                                                                                                                                                                                                                                        |
| Credential theft from disk                            | Only SHA-256 hashes of 256-bit device secrets are stored; files written atomically with `0600`                                                                                                                                                                                                                                                                                                                                                                        |
| A revoked device that keeps its connection open       | Its messages are ignored the moment it is revoked, its mouse lease is dropped, and the socket is terminated after one second                                                                                                                                                                                                                                                                                                                                          |
| Cross-site WebSocket hijacking / CSRF / DNS rebinding | WebSocket upgrades and POSTs require `Origin` = the request's own host; `Host` must be a name in the certificate                                                                                                                                                                                                                                                                                                                                                      |
| Malformed or flooding clients                         | Every message validated with zod, 64 KB frame limit, per-connection token bucket, bounded deltas                                                                                                                                                                                                                                                                                                                                                                      |
| Claude running tools without consent                  | `permissionMode: "default"`: anything Claude Code would ask about is routed to `canUseTool` and shown on the phone; `bypassPermissions`/`auto`/`dontAsk` cannot be configured and are reverted if project settings set them; approvals are tap-only (never by voice); unanswered approvals are denied after 15 minutes; "always allow" is limited to session-scoped allow rules or session-scoped `acceptEdits`                                                       |
| A hidden tail in an approved command                  | Approval details are never silently shortened: invisible and bidi characters are shown as `⟨U+…⟩`, and input too long to display in full (60k characters) can only be rejected — enforced by the agent, not just the UI                                                                                                                                                                                                                                               |
| A project's own settings pre-approving tools          | Like the CLI, sessions load the project's `.claude/settings*.json` (needed for CLAUDE.md). Its `permissions.allow` rules and hooks are listed when the project is added (the equivalent of Claude Code's folder-trust prompt), in `doctor`, and at the top of every session on the phone                                                                                                                                                                              |
| Claude working outside intended directories           | Sessions can only start in an allow-list of canonical (realpath) project directories managed from the PC                                                                                                                                                                                                                                                                                                                                                              |
| Stuck mouse buttons                                   | Buttons pressed under a lease are released when it ends, on disconnect, on driver exit and by the helper on EOF                                                                                                                                                                                                                                                                                                                                                       |
| Other local users driving the agent                   | Control channel is a named pipe / `0600` Unix socket plus a per-install secret                                                                                                                                                                                                                                                                                                                                                                                        |
| Exposure to the internet                              | Binds to the LAN; certificates are only valid for private addresses. Don't port-forward it. The optional Cloudflare Tunnel is the only supported way to expose it: it is off by default, `cloudflared` verifies the agent against the local CA, the tunnel host is added to the `Host`/`Origin` allow-list only while the tunnel is up, rate limits apply per visitor (`CF-Connecting-IP`, trusted only on loopback), and unpaired visitors aren't told the PC's name |

## Platform support

| Platform      | Mouse backend                                            | Notes                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11 | `voicecode-input.exe` (Win32 `SendInput`)                | Per-monitor DPI aware, multi-monitor, honours swapped buttons. Falls back to a PowerShell `SendInput` shim if the exe is missing. Input into apps running as Administrator is blocked by UIPI unless the agent is elevated too. |
| Linux X11     | `voicecode-input-x11` (XTest)                            | Falls back to `xdotool`. Honours the X pointer mapping.                                                                                                                                                                         |
| Linux Wayland | `voicecode-input-wayland` (RemoteDesktop portal + libei) | GNOME 46+ / KDE Plasma 6.1+. Asks for permission on the desktop once; falls back to `ydotool`. Pointer position is unavailable. See [native/linux-wayland](native/linux-wayland/README.md).                                     |

The agent must run inside your logged-in graphical session. A Windows service (Session 0)
or a headless Linux daemon cannot reach the desktop; `doctor` detects this.

**Voice** has two modes (Settings → Voice → Dictation):

- **Phone** (default) uses the browser's Web Speech API (Chrome/Edge on Android and
  desktop, Safari on iOS). Audio is processed by the browser/OS speech service and never
  reaches the agent; only the final transcript is sent. On browsers without it, use the
  keyboard's dictation key in the text box.
- **Claude Code** streams the phone's microphone to the agent as raw 16 kHz PCM over the
  same WebSocket (binary frames, only while the phone holds the microphone lease; one
  device at a time) and plays it into a virtual microphone on the PC, so Claude Code's own
  dictation (`/voice`, transcribed by Anthropic and tuned for code) can record it. Nothing
  is stored and no speech engine runs in the agent. Setup:
  - **Windows:** install [VB-CABLE](https://vb-audio.com/Cable/) (admin, reboot) and make
    **CABLE Output** the default input in Settings → System → Sound → Input. The agent
    plays into **CABLE Input** through `voicecode-audio-out.exe`; `config.json` →
    `voice.outputDevice` picks another device.
  - **Linux:** PipeWire with `pipewire-pulse` (`pactl`, `pw-cat`). The agent creates a
    null sink `voicecode_mic` and makes its monitor the default source while the phone
    streams, restoring your microphone afterwards.
  - In a terminal on the PC, sign in to Claude Code with a claude.ai account (an API key
    disables `/voice`) and run `/voice tap`. Hold the mic on the phone and speak; tap
    Space in the terminal to start and stop recording. `voicecode-agent doctor` checks
    all of this ("Phone microphone", "Claude Code voice").

## Development

Setting up a new machine, the test tiers (including the real-browser `npm run e2e`) and
troubleshooting are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

```bash
npm install
npm run build:native     # optional: native mouse helper (MinGW gcc/MSVC on Windows; gcc + libx11-dev libxtst-dev on Linux)
npm run build            # web client → agent bundle (apps/agent/dist)
node apps/agent/dist/cli.js start --project .
npm run build:sea        # optional: standalone executable for this platform (apps/agent/build/sea)
```

`npm run build:sea` bundles the CLI to CommonJS with esbuild and injects it, the web
client and any native helpers in `apps/agent/native-bin/` into a copy of the running
`node` binary. `node apps/agent/scripts/smoke-sea.mjs` then runs `init`, `start`, fetches
the web client over HTTPS and stops it, in a throwaway home directory (add
`--with-claude` to also test the Claude Code download).

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
native/linux-wayland/  RemoteDesktop portal + libei helper (C)
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
creates a GitHub release. The standalone executables are built and smoke-tested on each
target platform (including the real Claude Code download), then attached to the release
with `SHA256SUMS.txt` and build provenance attestations. Versions with a pre-release suffix (`1.0.0-beta.1`) go to the
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

- Optional PTY mode for attaching to an interactive `claude` terminal
- Keyboard input and text injection
