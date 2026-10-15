---
target: Deck.tsx
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
target_fingerprint: "sha256:64d82e78baee992f087ecb94ffd500fd25792d6f28e57506e12d06a9aaf93970"
target_path: "D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
timestamp: 2026-10-15T09-18-40Z
slug: apps-web-src-components-deck-tsx
---
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Light, status line and header chip now agree; light-theme amber LED is a pale dot; "Allowed: …" names only line one |
| 2 | Match System / Real World | 3 | Hardware metaphor holds; joystick directions unlabeled in normal mode |
| 3 | User Control and Freedom | 3 | Reject is a tap, joystick cancels by sliding back; macros fire with no undo |
| 4 | Consistency and Standards | 2 | Two Accepts in two languages: terracotta card pill (held) vs green deck key |
| 5 | Error Prevention | 3 | Hold + arming + id binding are excellent; macros and joystick stay live during an approval |
| 6 | Recognition Rather Than Recall | 2 | Joystick names only while pressed; wheel tap-for-latest invisible |
| 7 | Flexibility and Efficiency | 3 | Programmable keys/pad, keyboard hold, arrow keys on wheel and menu |
| 8 | Aesthetic and Minimalist Design | 3 | Calm; ~20 controls compete at the approval moment |
| 9 | Error Recovery | 2 | Quick-tap flash replaces the instruction; "Too many concurrent sessions" banner has no action |
| 10 | Help and Documentation | 2 | One empty-state line; the rest is learned by pressing |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

Authored for this product: state light behind glass, approval row with tool + first line + "+N lines", held Accept tied to a request id, wheel seen from above. Closest to generic: the six icon-plus-label macro tiles, and full-screen portrait spending its height on taller keys while the 64px joystick stays small.

Deterministic scan: CLI 1 finding (design-system-font, TerminalView.tsx:57, Menlo in the xterm fallback stack — false positive, but the stack differs from DESIGN.md's `ui-monospace, 'Cascadia Code', Consolas`). Deck files clean. Browser detector (dark, 3 views): nested-cards on .deck-display (partly real: panel > screen > bordered approval chip), repeating-stripes-gradient (false positive: wheel ridges), two text-occlusion hits under the open menu (false positive: opaque popover by design).

## Priority Issues

1. [P1] Two Accepts with two visual languages at the decision moment — card's terracotta pill gives no sign it must be held; deck's green key looks secondary. Fix: in deck mode, make the card's Accept match the deck key (green tone, "Hold to accept" label, visible fill track) or leave the card as review-only. Command: /impeccable clarify, /impeccable polish.
2. [P1] Macro keys and joystick stay live while an approval waits — a thumb reaching for Reject can send "Commit". Fix: dim and disable programmable keys and pad while an approval waits; keep Stop, Reject, Accept, Talk, Sessions. Command: /impeccable harden.
3. [P1] Landscape deck has no room for banners — at 844×390 the error and "approvals waiting" banners push the bottom row off screen; session bar wraps "my- / app", "1 on / PC". Fix: in landscape, banners overlay the conversation column, rows may shrink toward 44px, session-bar badges hide under ~300px. Command: /impeccable adapt.
4. [P2] "Allowed: Bash · cd apps/web" names only the first line of a 3-line command. Fix: add "+N lines" to the flash. Command: /impeccable clarify.
5. [P2] Light-theme approval LED is a pale peach dot. Fix: darker amber in light theme plus a 1px ring. Command: /impeccable colorize.

## Persona Red Flags

Alex: joystick commands invisible in normal mode; full-screen in landscape changes almost nothing.
Sam: quick-tap flash covers the visible instruction; usage ring numbers cramped (11px floor); light LED fails as a non-text signal.
Casey: ⋯ and full-screen at the top of the deck (hardest reach); the card's Accept, the biggest target, sits mid-screen above the deck; joystick ~64px.
Desk Dev (PRODUCT.md): relies on light and haptics; the light can't show an approval waiting in another session.

## Minor Observations

- No session: three "new" affordances (header +, empty-card button, New key).
- Full-screen with no session still shows the empty card.
- Toast covers the tabs and settings.
- Full-screen portrait keys stretch to ~110px tall instead of growing the display or pad.
- Usage rings colour amber/red (reviewer reads it as chart colour; it is a threshold warning backed by numbers).
- Full-screen reply flattens Markdown into " - " runs and "[code]".
- TerminalView mono stack differs from DESIGN.md.

## Questions to Consider

- If the deck is the instrument, should the card in deck mode be read-only evidence?
- Should the deck change shape during an approval (macros dark, Accept larger), or does "keys never move" win?
- What would an approval feel like with no screen at all — a distinct haptic pattern per state?
