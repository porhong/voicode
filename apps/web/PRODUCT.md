# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An installable PWA (React + Vite), served over LAN HTTPS by the `voicecode-agent` CLI on the
user's PC. It is used almost entirely on a phone, portrait and landscape.

## Users

A developer sitting at their own Windows or Linux PC who uses the phone next to the keyboard
as a second control surface for Claude Code: a deck of programmable keys, push-to-talk
dictation, a scroll wheel, approvals for tool calls, and a trackpad for the desktop mouse.
The phone sits on the desk or in one hand while the other hand and eyes stay mostly on the
PC. Driving Claude Code away from the desk works too but is secondary.

## Product Purpose

The phone becomes a dedicated controller for Claude Code on the PC. The user talks instead
of typing, approves or rejects every tool call with full detail, switches sessions and
models, and moves the cursor without reaching for the mouse. Success means the phone is
faster and calmer than doing the same thing on the PC, and nothing runs on the PC that the
user didn't see and approve.

## Positioning

A local, single-owner hardware-style controller for Claude Code. There is no cloud backend,
account or app store install: the PC is the server, the phone pairs once with a code, and
every tool call is approved on the phone. It drives both the Agent SDK sessions it starts
and the interactive `claude` the user already runs in a terminal (dictation through a
virtual microphone, take control of a terminal session).

## Operating Context

- Pairing: open the LAN URL or scan the QR code from the CLI, enter or confirm the
  single-use code, name the device. The local CA certificate may need installing.
- Claude tab: session bar, transcript, composer, permission cards, model and effort sheet,
  folder browser for workspace roots, "On this PC" sessions watched read-only, terminal
  view (xterm) for voice/terminal sessions.
- Deck: programmable keys, scroll wheel, joystick or usage rings pad, push-to-talk,
  full-screen mode and orientation lock.
- Trackpad tab: mouse movement, clicks and scrolling on the PC under an input lease.
- Settings: voice and dictation, alert sounds, storage cleanup, deck customisation.
- Optional Cloudflare Tunnel for access beyond the LAN (opt-in).

## Capabilities and Constraints

- Every HTTP and WebSocket request is from a paired device; pairing codes are single use,
  expire after 10 minutes and allow 5 attempts.
- Wire messages are defined by `packages/protocol` (zod); the UI shows what the agent
  sends and never invents state.
- Plan usage (5-hour and weekly windows) comes from the agent's probe and may be
  unavailable.
- Not verified yet on a real phone: certificate install, microphone and touch feel of
  the wheel, joystick and hold-to-talk. The orientation lock works only on Android
  (installed or fullscreen).
- Terminology: device, pairing code, session, approval / permission, deck, key, wheel,
  push-to-talk, workspace folder, take control.

## Brand Commitments

- Name: VoiceCode (npm `@anantbot/voicecode-agent`, command `voicecode-agent`).
- App icon in `public/icon.svg` and the PNG/maskable variants.
- Voice: plain, direct and technical; states facts and limits rather than selling.

## Evidence on Hand

- README and `docs/DEVELOPMENT.md` describe features and the security model.
- `apps/agent/scripts/ui-demo.ts` serves the built client against a fake Claude for
  screenshots.
- No testimonials, user counts, benchmarks or press exist; do not fabricate them.

## Product Principles

1. Approval safety first. A tool call shows its complete input before it can run, and
   approving is never easy to do by accident. Incomplete details can only be rejected.
2. One hand, one glance. Thumb-reachable 44px targets, readable at arm's length next to
   a keyboard, and usable without looking away from the PC for long.
3. Local and private. No accounts, telemetry or cloud dependency; the PC is the server.
4. Show the real state. Session, recording, approval and connection states come from the
   agent and are always visible and unambiguous.

## Accessibility & Inclusion

WCAG 2.1 AA contrast in both dark and light themes (already achieved; keep it), 44px
minimum touch targets, and keyboard-safe layout when the on-screen keyboard is open.
