# CLAUDE.md

Working notes for Claude Code on this repository. Machine setup and test commands are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); product docs and the security model are in the
[README](README.md).

## What this is

`voicecode-agent`: a CLI for Windows and Linux that serves a React PWA over LAN
HTTPS/WebSocket. A paired phone drives Claude Code through `@anthropic-ai/claude-agent-sdk`
(every tool call is approved or rejected on the phone) and uses the phone as a trackpad
through native input helpers. Shipped on npm and as standalone executables (Node SEA).

## Layout

```
packages/protocol   zod wire schemas + types shared by agent and web (PROTOCOL_VERSION)
packages/security   pairing codes, secret hashing, local CA (@peculiar/x509)
apps/agent          CLI + server, bundled with tsup (npm) or esbuild (SEA)
  src/cli/commands  init start status pair devices sessions projects tunnel autostart firewall doctor stop
  src/server        Fastify app, origin/host guard, cookie auth, WebSocket gateway
  src/claude        ClaudeSession (SDK query), ApprovalBroker (canUseTool), claude-executable (SEA download)
  src/tunnel        cloudflared config + process supervisor (optional Cloudflare Tunnel)
  src/sessions      SessionManager (phone sessions), PcSessionWatcher (read-only view of all
                    Claude sessions on the PC via ~/.claude/sessions + transcripts)
  src/mouse         InputRouter (lease, coalescing), helper-process / command drivers
  src/util          standalone.ts (SEA assets), tar.ts, logger, network
  scripts           copy-web, prepack, build-sea, smoke-sea, ui-demo (fake Claude for UI work)
apps/web            React PWA (Vite): Pair page, Claude tab, Trackpad tab, settings
native/             C helpers: windows (SendInput), linux-x11 (XTest), linux-wayland (portal + libei)
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
  tag (`npm run release -- <version>`), and the first publish needs the owner's
  `NPM_TOKEN`.
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
- Real Claude flows were checked in headless Chrome.
- Mouse movement was checked pixel-exact on Windows.
- Mobile UX pass on the web client (compact session header + sheet, one-button composer,
  smart scroll, keyboard-safe height, WCAG AA contrast, 44px targets) checked with
  `ui-demo.ts` screenshots at 390/360 px and landscape, dark and light.

Not verified yet:

- A real phone: certificate install, microphone, touch.
- The Wayland helper on a real desktop (it is only compile-checked).
- The first npm publish, which needs the owner's token.
- PC session discovery reads Claude Code internals (`~/.claude/sessions/<pid>.json`,
  transcript JSONL); checked against Claude Code 2.1.299 only. Parsing is lenient.
- Cloudflare Tunnel: quick mode was checked end to end through Cloudflare (pairing,
  cookie, WebSocket). `tunnel setup` and `tunnel token` need a Cloudflare account and a
  domain, so only their generated ingress config was validated with cloudflared.

Next candidates, in rough priority:

1. Keyboard input and text injection.
2. PTY mode for attaching to an interactive `claude`.
3. Code-signing the Windows `.exe`.
