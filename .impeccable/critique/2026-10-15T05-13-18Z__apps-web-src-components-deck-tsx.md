---
target: apps/web/src/components/Deck.tsx
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
target_fingerprint: "sha256:6af8b8fbec2599add50785eaa4578a5fed378a2dc829b6f9ab06857d27bd8644"
target_path: "D:\\Others\\voicode\\apps\\web\\src\\components\\Deck.tsx"
timestamp: 2026-10-15T05-13-18Z
slug: apps-web-src-components-deck-tsx
closed: true
---
Method: dual-agent (A: design review sub-agent · B: detector/browser sub-agent)

## Design Health Score — 25/40 (Acceptable; previous run 24/40)

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Header chip "Ready" vs deck "Done"; hints and flashes overwrite the state line |
| 2 | Match System / Real World | 3 | Macro-pad metaphor lands; "1 on PC" chip wraps |
| 3 | User Control and Freedom | 2 | Macros send on one tap, no undo |
| 4 | Consistency and Standards | 2 | Same approval: terracotta tap Accept on the card, green hold Accept on the deck |
| 5 | Error Prevention | 2 | Card's tap Accept bypasses the deck's hold and arming |
| 6 | Recognition Rather Than Recall | 3 | Joystick names only in full mode |
| 7 | Flexibility and Efficiency | 3 | Customisable, keyboard holds; no accelerators |
| 8 | Aesthetic and Minimalist Design | 3 | Card and deck show the same decision twice |
| 9 | Error Recovery | 2 | "Hold Accept to allow it" good; "Stopped with an error" no next step |
| 10 | Help and Documentation | 2 | Empty state still points to a "sliders button" that the layout pass removed |

## Design Specificity Verdict
Specific: state light behind glass, held Accept with arming, wheel that pages replies, amber approval row matching the amber light, one grid in every layout. Generic parts are around the deck (empty card, toast, header chips).
Detector: 0 findings in Deck.tsx, UsagePad.tsx, DeckEditor.tsx, DeckIcons.tsx, Icons.tsx. styles.css deck-relevant: real — usage labels 0.66–0.68rem (2056, 2081), off-ramp sizes (1647, 2129, 2165), 12px radii (1524, 2317, 2352), stick dir 0.7rem (1907); false positives — wheel ridges; documented — nested display panels. Browser overlay (CSP bypassed): lit Reject caption 2.3:1 dark / 3.8:1 light, lit Accept caption 3.8:1 dark / 4.0:1 light (real, AA fail); user-bubble meta 4.4:1 light (outside deck).

## Priority Issues
1. [P1] The card's tap Accept bypasses the deck's hold (PermissionCard.tsx:63-68). Fix: in deck mode the card's Accept uses the same hold control, or the card becomes a read-only input viewer; one Accept colour. → /impeccable harden
2. [P1] Lit Accept/Reject captions fail AA (2.3–4.0:1) on their tinted keys over the light. Fix: deepen the tone for text (or caption in --text, tone only on the icon/border); check against the pulsing amber light. → /impeccable colorize
3. [P1] One line carries state, hints and flashes in the live region; header chip can disagree. Fix: persistent state line (live), separate non-live hint line; header chip from the same DeckStatus. → /impeccable clarify
4. [P2] Approval row shows only the first input line. Fix: "+N lines" marker when the summary isn't the whole input. → /impeccable harden
5. [P2] Copy and finish defects: stale "sliders button" text (ControllerPage.tsx:309, regression from the layout pass); ⋯ menu 88% opaque so keys show through; no visible "Allowed" confirmation after a hold; usage rings use state colours as a chart, "+N" badge overlaps a ring. → /impeccable polish

## Persona Red Flags
- Alex: no accelerators; rarely-changed settings behind ⋯.
- Sam: polite live region chatters with hints; assistive-tech click accepts at once (deliberate, should be documented).
- Casey: ⋯ and full-screen tools sit top-right, hardest thumb reach.
- Dev at desk: only a 30 ms buzz confirms an accept; toasts can cover the tabs mid-approval.

## Minor Observations
- Light "Hold to talk" tint reads muddy; green caption on green fill mid-hold loses contrast.
- Stop enabled next to lit Reject during approvals.
- Full-screen reply shows "[code]" and loose list dashes.

## Questions to Consider
- In deck mode, should the card keep its own answer buttons at all?
- Should Accept require the full input to have been on screen?
- What does the deck say back, in words, the second after you accept?
