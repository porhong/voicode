# Developing VoiceCode Agent

Everything needed to set up a new machine and carry on working. For what the project does
and how users install it, see the [README](../README.md); for Claude Code's working notes,
see [CLAUDE.md](../CLAUDE.md).

## 1. Set up a machine

| Tool                  | Version   | Notes                                                                                      |
| --------------------- | --------- | ------------------------------------------------------------------------------------------ |
| Node.js               | 24.x      | 22.12+ runs the agent; 24 matches CI and is required for `build:sea`. npm 11 comes with it |
| Git                   | any       |                                                                                            |
| GitHub CLI (`gh`)     | any       | Optional: CI status, releases, PRs. `gh auth login`                                        |
| Claude Code login     | —         | `claude` → `/login`, or set `ANTHROPIC_API_KEY`. Needed for real sessions only             |
| Google Chrome         | any       | Optional: the browser end-to-end test (`npm run e2e`)                                      |
| C compiler (optional) | see below | Only for building the native mouse helpers locally                                         |

Native helper toolchains (the agent falls back to PowerShell / `xdotool` / `ydotool`
without them, and CI builds the release binaries anyway):

- **Windows**: MinGW-w64 `gcc` on `PATH` (e.g. [MSYS2](https://www.msys2.org/) →
  `pacman -S mingw-w64-ucrt-x86_64-gcc`, then add `C:\msys64\ucrt64\bin` to `PATH`) or
  MSVC `cl` from a Developer Command Prompt.
- **Linux X11**: `sudo apt install build-essential libx11-dev libxtst-dev`
- **Linux Wayland** (Ubuntu 24.04+ / Fedora 39+):
  `sudo apt install build-essential pkg-config libglib2.0-dev libei-dev`

## 2. Get the code running

```bash
git clone https://github.com/porhong/voicode.git
cd voicode
npm ci                    # exact versions from package-lock.json
npm run build:native      # optional, see above
npm run build             # web client, then the agent bundle (apps/agent/dist)
npm run lint && npm run typecheck && npm test
```

Git identity for this repository (commits use the GitHub no-reply address):

```bash
git config user.name "KEAT PORHONG"
git config user.email "74444130+porhong@users.noreply.github.com"
```

Run the agent from source against a scratch project:

```bash
node apps/agent/dist/cli.js init --project ../scratch
node apps/agent/dist/cli.js start
```

Use `VOICECODE_HOME=<dir>` (config, certificates, devices) and `VOICECODE_CACHE_DIR=<dir>`
to keep a development agent separate from an installed one.

**Live reload**: `npm run dev:agent` (tsx watch) plus `npm run dev:web` (Vite). The Vite
dev server reuses the agent's certificate and proxies `/api` and `/ws` to
`VOICECODE_AGENT_URL` (default `https://127.0.0.1:8443`).

## 3. Testing

| Command                                 | What it covers                                                                                                                                                                                                    | Cost        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `npm test`                              | Vitest: pairing, CA + real TLS handshakes, router, approval broker, autostart, tar/download verification, web store/gestures/Markdown, HTTPS/WS e2e with a fake SDK                                               | free        |
| `node apps/agent/scripts/smoke-sea.mjs` | Standalone binary: init, start, web client over HTTPS, status, stop                                                                                                                                               | free        |
| `… smoke-sea.mjs --with-claude`         | Same, plus the real Claude Code download (~115 MB) and `claude --version`                                                                                                                                         | bandwidth   |
| `npm run e2e -- <url> <pairing code>`   | Real web client in headless Chrome against a running agent with real Claude: pair, prompt, approval, reply, trackpad. Moves the real cursor slightly                                                              | a few cents |
| `npx tsx apps/agent/scripts/ui-demo.ts` | The built web client against a fake Claude and fake mouse; then `node scripts/ui-screenshots.mjs <url> <dir> [dark\|light]` for phone-size screenshots (`W=844 H=390` for landscape), or `npm run e2e` against it | free        |
| `voicecode-agent doctor`                | The environment on this machine                                                                                                                                                                                   | free        |

UI work: rebuild (`npm run build`) and restart `ui-demo.ts` after changes, since it serves `apps/agent/dist/web` and only registers asset routes at start. `E2E_BROWSER=msedge` uses Edge where Chrome is not installed.

For `npm run e2e`, start an agent with a throwaway project first
(`node apps/agent/dist/cli.js start --project <scratch dir>`) and pass the URL and pairing
code it prints. Screenshots land in `e2e-shots/`.

Before pushing, run what CI runs: `npm run format:check && npm run lint && npm run
typecheck && npm test && npm run build && npm run verify:package`. `npm run format` fixes
formatting.

## 4. Standalone executables

```bash
npm run build && npm run build:sea     # → apps/agent/build/sea/voicecode-agent[.exe]
node apps/agent/scripts/smoke-sea.mjs
```

The binary embeds the Node.js running the build, so build with Node 24. Native helpers
found in `apps/agent/native-bin/<platform>-<arch>/` are embedded; release builds pass
`--require-native`. Details: [README → Standalone executables](../README.md#standalone-executables)
and the header of `apps/agent/scripts/build-sea.mjs`.

## 5. CI and releases

- **CI** (`.github/workflows/ci.yml`): format, lint, typecheck, test, build and package
  check on Ubuntu and Windows; native helpers for all targets (`native.yml`); standalone
  binaries built and smoke-tested on Windows x64, Linux x64 and Linux arm64
  (`standalone.yml`).
- **Release** (`release.yml`): `npm run release -- <patch|minor|major|x.y.z>` bumps the
  version, commits and tags; `git push origin main v<version>` publishes to npm and
  creates the GitHub release with the standalone archives, `SHA256SUMS.txt` and
  attestations. Running the workflow manually is a full dry run.
- **First npm publish** still needs one-time setup by the repository owner (an
  `NPM_TOKEN` secret, then trusted publishing); see [README → Releasing](../README.md#releasing).
- **Dependabot** opens weekly grouped PRs for npm packages and GitHub Actions. Merge them
  once CI is green; if the lockfile conflicts, keep `main`'s lockfile and run
  `npm install` to regenerate it.

## 6. Troubleshooting

| Symptom                                             | Fix                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` is slow / downloads ~250 MB                | Expected: the Agent SDK pulls the Claude Code binary for your platform as an optional dependency                              |
| Phone can't connect on Windows                      | `voicecode-agent firewall` (one admin prompt); `doctor` warns when the network profile is Public                              |
| Browser shows a certificate warning / no microphone | Install the CA from `https://<pc>:<port>/voicecode-ca.crt` on the device (README → Trust the agent's certificate)             |
| Tunnel URL shows 502 / "Unavailable"                | `voicecode-agent tunnel` and `doctor`; cloudflared's own log lines are in `agent.log` (`"component":"tunnel"`)                |
| `Port … is already in use`                          | Another agent is running (`voicecode-agent status` / `stop`) or pick `--port`                                                 |
| Mouse unavailable                                   | `voicecode-agent doctor`; build the native helper or install `xdotool` / `ydotool`; the agent must run in the desktop session |
| Phone microphone unavailable                        | `voicecode-agent doctor`; Windows needs VB-CABLE and `voicecode-audio-out.exe` (`npm run build:native`), Linux needs PipeWire |
