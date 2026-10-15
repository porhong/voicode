---
target: apps/web/src/components/Deck.tsx
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
target_fingerprint: "sha256:9e6707c4e3c228aa0f0cadbd43dc3352077a4e1f90033f22ea77e6d1e8b0994c"
target_path: "D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
timestamp: 2026-10-15T03-48-54Z
slug: apps-web-src-components-deck-tsx
closed: true
---
Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent)

## Design Health Score — 24/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Light + LED + text agree, but status truncates at the key moment ("Needs your appro…") |
| 2 | Match System / Real World | 3 | Hardware metaphors land; wheel scrolls like a mouse wheel (down = later), opposite of touch scrolling above it (deliberate, Deck.tsx:136) |
| 3 | User Control and Freedom | 2 | Macros fire on one tap ("Sent: Commit") with no undo; joystick cancel is good |
| 4 | Consistency and Standards | 2 | Accept is terracotta on the card, green on the deck; full mode moves Accept/Reject/stick |
| 5 | Error Prevention | 2 | Deck Accept is a blind single tap on `activePermissions[0]` (ControllerPage.tsx:332), no arming, no tool name |
| 6 | Recognition Rather Than Recall | 2 | Joystick bindings unlabelled outside full mode; 4 icon-only display tools |
| 7 | Flexibility and Efficiency | 3 | Customisable keys/stick, keyboard wheel and PTT; no second layer, no "allow for session" |
| 8 | Aesthetic and Minimalist Design | 3 | Calm at rest; ~25 targets and five lit colours during an approval |
| 9 | Error Recovery | 2 | Good flashes; "Stopped with an error" has no cause |
| 10 | Help and Documentation | 2 | Hints only appear while pressing |

## Design Specificity Verdict
Grounded, not interchangeable: Run tests / Diff / Commit / Accept / Reject keys, wheel that pages Claude's replies, joystick that previews its action and cancels on return to centre. Generic parts: four unlabelled icon tools on the display bar, the dashboard-donut usage rings, and the glass + glow that drifts toward gamer RGB when five colours are lit at once.
Detector: 0 findings in Deck.tsx/DeckEditor.tsx/DeckIcons.tsx/UsagePad.tsx. Deck CSS has advisories only: real — usage labels at 0.66–0.68rem (styles.css:1940,1965), `.deck-tool` 12px radius (1524), slider-thumb shadows (2105,2113); false positives — wheel ridge `#000` mask and 2px radius (1750–1752), `repeating-stripes-gradient` (the wheel ridges); documented — `nested-cards` on the deck display. Browser overlay (headless, CSP bypassed; CSP `script-src 'self'` blocks injection otherwise) found one real issue outside the deck: `.msg-user .msg-meta` 4.4:1 in light mode (styles.css:622).

## Priority Issues
1. [P1] Deck Accept is a blind single tap — no arming delay, no tool named, answers the first of N queued approvals silently. Fix: hold-to-confirm (~600 ms ring fill, mirrors hold-to-talk), ignore presses for ~500 ms after enabling, show "Bash · npm test -- --run · 1 of 3" on the display. → /impeccable harden
2. [P1] Display bar tools crowd out status — status truncates exactly during approvals. Fix: status gets its own full-width line; rotate + usage move to one overflow or the Customize sheet. → /impeccable layout
3. [P2] Full mode relocates controls — Accept, Reject and the joystick move between layouts, breaking muscle memory. Fix: command and mic rows fixed in every layout; full mode changes only the display and macro block. → /impeccable layout
4. [P2] Joystick bindings hidden, targets tiny — recall-only arrows in normal mode, `.deck-stick-dir` min-width 18px, ~64 px pad. Fix: short labels or an at-rest legend on the display; 44 px hit areas. → /impeccable adapt
5. [P2] Colour discipline — usage rings use amber/red thresholds (Light Means State rule), Accept two colours, five colours lit during approval. Fix: one Accept colour; neutral rings with terracotta past a limit; dim macros/stick while an approval waits. → /impeccable quieter

## Persona Red Flags
- Alex: no long-press second layer; no "allow for session" from the deck; queued approvals answered first-in with no count.
- Sam: wheel is a `<button>` that takes arrow keys (should be slider/spinbutton); the `role="status"` live region also carries press hints and flashes (chatty); "Accept" names no tool; usage toggle label stays "Show usage limits instead of the joystick" when on (Deck.tsx:551).
- Casey: full-portrait tools sit at the top of the screen; joystick too small; Accept in the hottest thumb zone.
- Dev at desk: glance shows only a truncated "Needs your appro…"; knowing *what* is being approved needs a look at the card; realistic failure is approving by feel.

## Minor Observations
- `plainReply` leaves list dashes inline ("…greeting - Ran the test suite").
- "+3" usage overflow badge collides with the ring in landscape.
- Landscape full mode: dead space under a 4-line-clamped reply.
- 390 px header: chip wraps to "1 on / PC", title truncates to "Run the t…".
- A toast covers the tabs during an approval.

## Questions to Consider
- If eyes are on the PC, why isn't the approval on the deck display, with the card secondary?
- Should Accept be the one key that is held, never tapped?
- Is usage glanceable state for the display bar rather than a replacement for a control?
- Should macros and the joystick dim while an approval waits?
