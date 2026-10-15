---
name: VoiceCode
description: A phone-sized desk instrument for driving Claude Code on your PC.
colors:
  ink: '#0f1115'
  ink-surface: '#181b21'
  ink-raised: '#20242c'
  ink-rule: '#2b303a'
  bone: '#f3f1ec'
  slate-muted: '#9aa0ab'
  kiln-terracotta: '#d97757'
  kiln-ink: '#1a0f0a'
  signal-red: '#ff6369'
  go-green: '#46a758'
  caution-amber: '#f5a524'
  ready-cyan: '#4cc9e0'
  done-green: '#33c26b'
  idle-grey: '#8a919e'
  listen-violet: '#9d8cff'
  paper: '#f6f5f2'
  paper-surface: '#ffffff'
  paper-raised: '#efede8'
  paper-rule: '#dedad2'
  paper-ink: '#1d1b18'
  paper-muted: '#6b6760'
  kiln-terracotta-light: '#b2492a'
  signal-red-light: '#c42b31'
  go-green-light: '#1f7a35'
  listen-violet-light: '#5b4bd8'
typography:
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1.5rem'
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '1.2rem'
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '0.75rem'
    fontWeight: 700
    lineHeight: 1.3
  overline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: '0.8rem'
    fontWeight: 600
    letterSpacing: '0.06em'
  mono:
    fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace"
    fontSize: '0.8rem'
    fontWeight: 400
    lineHeight: 1.45
rounded:
  code: '6px'
  detail: '8px'
  field: '10px'
  card: '14px'
  sheet: '20px'
  glass: '24px'
  pill: '999px'
spacing:
  xs: '0.25rem'
  sm: '0.5rem'
  md: '0.75rem'
  lg: '1.25rem'
  target: '44px'
components:
  button:
    backgroundColor: '{colors.ink-raised}'
    textColor: '{colors.bone}'
    rounded: '{rounded.pill}'
    padding: '0.7rem 1.1rem'
    height: '44px'
  button-primary:
    backgroundColor: '{colors.kiln-terracotta}'
    textColor: '{colors.kiln-ink}'
    rounded: '{rounded.pill}'
    padding: '0.7rem 1.1rem'
    height: '44px'
  button-danger:
    textColor: '{colors.signal-red}'
    rounded: '{rounded.pill}'
    padding: '0.7rem 1.1rem'
    height: '44px'
  input:
    backgroundColor: '{colors.ink-surface}'
    textColor: '{colors.bone}'
    rounded: '{rounded.field}'
    padding: '0.65rem 0.8rem'
  chip:
    backgroundColor: '{colors.ink-raised}'
    textColor: '{colors.kiln-terracotta}'
    typography: '{typography.label}'
    rounded: '{rounded.pill}'
    padding: '0.25rem 0.6rem'
  tabs:
    backgroundColor: '{colors.ink-raised}'
    textColor: '{colors.slate-muted}'
    rounded: '{rounded.pill}'
    padding: '2px'
  tab-active:
    backgroundColor: '{colors.ink-surface}'
    textColor: '{colors.bone}'
    rounded: '{rounded.pill}'
    height: '44px'
  permission-card:
    backgroundColor: '{colors.ink-surface}'
    rounded: '{rounded.card}'
    padding: '0.9rem'
  sheet:
    backgroundColor: '{colors.ink-surface}'
    rounded: '{rounded.sheet}'
    padding: '0 1.1rem 1.25rem'
  deck-key:
    textColor: '{colors.bone}'
    rounded: '{rounded.card}'
    height: '50px'
  composer-action:
    backgroundColor: '{colors.kiln-terracotta}'
    textColor: '{colors.kiln-ink}'
    rounded: '{rounded.pill}'
    size: '48px'
---

# Design System: VoiceCode

## Overview

**Creative North Star: "The Desk Instrument"**

VoiceCode is a piece of studio hardware that happens to run in a phone browser. It sits
next to the keyboard like a stream deck or a synth controller: a dark, warm body, rounded
keys you press with a thumb, and one soft light that tells you what Claude is doing without
you having to read anything. The rest of the app (pairing, transcript, settings) is the
instrument's quiet manual: flat ink surfaces, system type, generous 44px targets.

Density is medium and deliberate. Every control is finger-sized and reachable with one
hand, and text is set at a size that reads at arm's length next to a monitor. Expression is
concentrated in exactly two places: the Kiln Terracotta accent that marks what you can act
on, and the deck's state light. Everything else holds back so those two stay legible.

It must never read as gamer RGB, a generic SaaS dashboard, a chat-app clone or
skeuomorphic chrome. It is a calm instrument, not a toy, a report or a messenger.

**Key Characteristics:**

- Warm near-black ink in dark mode, warm paper in light; both meet WCAG AA.
- One accent, Kiln Terracotta, for primary actions, the user's own messages and
  attention.
- Pills for actions, 14px rounded rectangles for keys and cards, a 24px glass slab for the
  deck.
- Flat and tonal everywhere except the deck (frosted glass + state light) and things that
  interrupt you (approvals, sheets, toasts), which lift with a shadow.
- Tactile and calm: presses scale to 0.96–0.97, nothing glows unless it means something.

## Colors

A warm-neutral ink palette with a single fired-clay accent and a small set of state colours
that belong to the instrument's light, not to decoration.

### Primary

- **Kiln Terracotta** (dark `kiln-terracotta`, light `kiln-terracotta-light`): primary
  buttons, the send/talk action, the user's own message bubbles, the active-session chip,
  the awaiting-approval border on permission cards, links and the focus ring. Text on it is
  **Kiln Ink** in dark mode and white in light mode.
- **Accent Wash** (`color-mix(in srgb, var(--accent) 16%, transparent)`): selected and
  highlighted rows; never a fill for a large surface.

### Secondary

- **Listen Violet** (dark `listen-violet`, light `listen-violet-light`): dictation only.
  The deck light and the push-to-talk key's glyph go violet while the microphone is live.

### Tertiary (state light)

- **Ready Cyan** (`ready-cyan`): the deck light at rest.
- **Caution Amber** (`caution-amber`): an approval is waiting; the light pulses.
- **Done Green** (`done-green`): a turn finished; the light blooms once.
- **Go Green** (`go-green` / `go-green-light`): Accept key, idle chip, success toasts.
- **Signal Red** (`signal-red` / `signal-red-light`): Reject and Stop, errors, danger
  buttons (outline only).
- **Idle Grey** (`idle-grey`): no session, a closed session, or a read-only PC session.

### Neutral

- **Ink** (`ink`) / **Paper** (`paper`): the page background.
- **Ink Surface** (`ink-surface`) / **Paper Surface** (`paper-surface`): cards, sheets,
  the composer, assistant bubbles, inputs.
- **Ink Raised** (`ink-raised`) / **Paper Raised** (`paper-raised`): default buttons, the
  tab track, chips, inline code.
- **Ink Rule** (`ink-rule`) / **Paper Rule** (`paper-rule`): 1px borders and dividers.
- **Bone** (`bone`) / **Paper Ink** (`paper-ink`): body text.
- **Slate Muted** (`slate-muted`) / **Paper Muted** (`paper-muted`): captions, project
  names, inactive tabs, key captions.

### Named Rules

**The One Clay Rule.** Kiln Terracotta is the only brand colour. It marks what you can act
on or what needs you; it is never a background for a whole region or a decorative stripe.

**The Light Means State Rule.** Cyan, amber, green, red, grey and violet exist to report
Claude's state through the deck light and command keys. Never use them for decoration,
categories or charts.

**The Two Red Keys Rule.** When Reject is lit, Stop colours only its glyph so two red keys
never compete.

## Typography

**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, sans-serif)
**Mono Font:** ui-monospace (with Cascadia Code, Consolas, monospace)

**Character:** The phone's own system face, so the app feels native on any device and costs
no download. Hierarchy comes from weight (600/700) and small size steps, not from a display
face.

### Hierarchy

- **Headline** (700, 1.5rem): the Pair page title; the only large type in the app.
- **Title** (700, 1.2rem): sheet titles; centred status titles use 1.35rem.
- **Body** (400, 16px, 1.45): transcript, inputs and buttons (buttons at 600). The 16px
  base also stops iOS from zooming on focus.
- **Label** (600–700, 0.72–0.9rem): chips, tabs, key captions, session project names.
- **Overline** (600, 0.8rem, 0.06em, uppercase, muted): sheet section headings and the
  permission badge (0.7rem, 0.05em).
- **Mono** (0.8–0.9em): tool input in permission cards, inline code, the terminal view.

### Named Rules

**The No Display Face Rule.** No web fonts and nothing above 2rem. An instrument labels its
controls; it doesn't headline them.

## Layout

A single full-height column built for a phone held in portrait, with a landscape variant.
The header (session switcher + chip) is at least 58px; the transcript scrolls; the composer
or the deck sits at the bottom, padded by the safe-area insets (`--safe-*`) and kept above
the on-screen keyboard (`--app-height`).

The deck is a named-area grid: twelve equal key columns plus a finger-wide 64px column for
the wheel over the pad; rows are `clamp(50px, 7vh, 60px)` with 0.5rem gaps. Layouts
(portrait, landscape, full-screen) change only the grid areas, never the markup.

Spacing runs in small rem steps (0.25, 0.5, 0.6–0.75, 0.9, 1.1–1.25rem); edges of the app
use 0.6–0.75rem gutters. Every interactive element is at least 44px tall; approval buttons
are 50px. From 720px wide, sheets centre at 480px and become fully rounded cards.

## Elevation & Depth

Flat by default. Pages and lists separate by tone (ink → surface → raised) and 1px rules,
not shadows. Depth is reserved for two things: the deck, which is the instrument and gets
frosted glass and its light, and anything that interrupts you.

### Shadow Vocabulary

- **Interrupt lift** (`0 8px 24px rgb(0 0 0 / 0.35)` dark, `0.12` light): permission
  cards, toasts and floating buttons.
- **Deck slab** (`inset 0 1px 0 rgb(255 255 255 / 0.06), 0 0 0 1px <light 24%>, 0 12px
32px rgb(0 0 0 / 0.2)`): the glass deck, with a hairline tinted by the state light.
- **Backdrop** (`rgb(0 0 0 / 0.5)`): behind sheets.

### Named Rules

**The Glass Stays on the Deck Rule.** Frosted glass (`blur(24px) saturate(160%)`) and the
blurred state light belong to the deck only. Headers, sheets and cards stay opaque and flat.

**The Lift Means Interrupt Rule.** A shadow says "this needs you now": approvals, sheets,
toasts. Static content never gets one.

## Shapes

Three shape families. **Pills** (999px) for every action and toggle: buttons, tabs, chips,
the composer input (24px on a 48px field) and round icon buttons. **Rounded rectangles**
(14px) for keys, cards, toasts, the deck display and message bubbles, whose corner nearest
the speaker tightens to 6px. **The slab** (24px) for the deck itself, and a 20px top edge
for bottom sheets. Fields use 10px, detail panes 8px, inline code 6px.

## Components

### Buttons

Tactile and calm: a pill you press, which gives a little.

- **Shape:** full pill (999px), minimum 44px tall, 0.7rem × 1.1rem padding, 600 weight.
- **Default:** Ink Raised fill with a 1px Ink Rule border.
- **Primary:** Kiln Terracotta fill and border, Kiln Ink text.
- **Danger:** transparent with a Signal Red border and text; red never fills a button.
- **Ghost:** transparent default. **Link:** text-only in the accent, still 44px tall.
- **Press:** `scale(0.97)`; disabled at 45% opacity. Focus is a 2px accent outline, 2px
  offset.

### Chips

- **Style:** pill, Ink Raised fill, 0.75rem/700 label.
- **State:** running text in terracotta; awaiting approval fills terracotta; idle in Go
  Green; error in Signal Red.

### Cards / Containers

- **Permission card:** Ink Surface, 14px corners, 0.9rem padding, a 2px Kiln Terracotta
  border and the interrupt lift. The tool input sits in an Ink well (8px corners, mono
  0.8rem, up to 28vh, scrolls). Approve / Reject are a two-column grid of 50px pills.
- **Toast:** Ink Surface, 14px, a 4px left edge in Go Green or Signal Red, interrupt lift,
  slides in over 0.2s.
- **Message bubbles:** user messages in Kiln Terracotta on the right; assistant messages
  in Ink Surface with a rule on the left; max 92% wide.

### Inputs / Fields

- **Style:** Ink Surface fill, 1px border mixed from Slate Muted, 10px corners.
- **Focus:** 2px Kiln Terracotta outline, 1px offset.
- **Composer:** a 48px pill textarea (grows to 9.5rem) beside a 48px round terracotta
  action that greys out when disabled.

### Navigation

- **Tabs:** a pill track in Ink Raised with 2px padding; the active tab is an Ink Surface
  pill with Bone text, inactive tabs are Slate Muted, 0.9rem/600, 44px tall. Badges are
  small terracotta pills.
- **Sheets:** bottom sheets with a 40 × 5px handle, 20px top corners, rise 24px over
  0.22s; centred 480px cards from 720px.

### The Deck (signature)

The instrument itself: a 24px glass slab over a blurred two-blob state light.

- **Keys:** 14px corners, a translucent white key fill (`--key`) with a hairline edge;
  press scales to 0.96 and brightens (`--key-press`). Captions are 0.72rem/600 muted.
- **Command keys** take their tone only when they can act: Accept green, Reject and Stop
  red, as a 20% tint on a solid surface face (not glass, so the pulsing state light never
  washes out the label) and a 55% border. The label is the tone mixed 45% into the text
  colour and the glyph 70%, which measured 7.4:1 or more for the labels and 5.8:1 or more for
  the glyphs in both themes, through the pulse; while Accept is held, both switch to the
  text colour over the fill.
- **Accept is held, never tapped:** 600ms, while a fill of its tone (42%) rises from the
  bottom of the key; letting go early flashes "Hold Accept to allow it". Accept and Reject
  stay dark for 500ms after an approval arrives. The fill keeps moving under reduced
  motion, because it is progress, not decoration.
- **The card is for review, the deck answers:** in the deck layout the permission card
  has no Accept or Reject. It shows the full input and "Answer on the deck: hold Accept,
  or tap Reject" (a queued card says it is next). It keeps "Reject with feedback", which
  opens the text box and a "Reject with this feedback" button, and the held "Always allow"
  (`useHoldToConfirm`, an accent wash rising behind the link), which the deck has no key
  for. One primary control for one decision.
- **One thing at a time:** while an approval waits, the six programmable keys and the
  joystick or usage pad go dark (disabled, 35–40% opacity) but keep their places. Stop,
  Reject, Accept, New, Type, Hold to talk and Sessions stay live. "Allowed: Bash · cd
  apps/web +2 lines" names what was allowed, the whole of it.
- **Banners never move the deck:** in the deck layout the agent banners (reconnecting,
  errors, reload) sit at the top of the conversation column, not above the whole tab.
- **One shape in every layout:** the grid areas are the same in normal and full-screen,
  portrait and landscape; full-screen only makes the rows taller (four rows of at least
  52px). Accept, Reject, Stop and hold-to-talk never move. In full-screen the joystick's
  four names sit on one line under the display bar instead of on the small pad.
- **Display bar:** the status text and two tools only: full-screen and an opaque "more" menu
  (Pad: Joystick | Usage; Screen: Auto | Portrait | Landscape; Customize deck…). Each
  setting is one row of choices, the chosen one on an accent wash.
- **Status line:** it shows the session's state ("Ready", "Claude is working…", "Done",
  "Hold Accept to allow"), the same state the header chip shows. A pressed key's name or a
  moment's feedback ("Allowed: Bash · npm test", "Sent: Review", 1.8s) covers it briefly
  and then the state returns. Screen readers hear the state only when it changes, and the
  feedback through a separate live region; key names are not announced, since each key
  has its own label.
- **Approval row:** while an approval waits, a single line under the display bar names it:
  uppercase tool, the first line of its input in mono, a "+N lines" chip (22% amber) when
  the input runs longer, and "1 of 3" when more are queued,
  on a 16% Caution Amber wash with no border (it is part of the display, not a card
  inside it). It replaces the reply in
  full-screen mode.
- **Push-to-talk:** a wide key tinted 14% terracotta with a terracotta mic glyph; it goes
  violet while listening.
- **State light:** cyan at rest, terracotta drift while working (6–8s), amber pulse
  (1.3s) for approvals, a single green bloom when done, steady red on error, dim grey with
  no session, fast violet pulse while dictating. Fades between states over 0.6s via the
  registered `--deck-light` property. On the light display the LED gets a 1px ring, a
  deeper amber (#b86e00) for approvals and a shallower blink (to 60%, not 35%).
- **Display:** a 14px screen panel (`--screen`) showing state, tools and the latest reply.
- **Wheel, joystick and usage rings** occupy the narrow right column.

## Do's and Don'ts

### Do:

- **Do** keep every interactive target at least 44px tall, and approval actions at 50px.
- **Do** show a tool call's complete input in the mono well of the permission card before
  Approve is reachable.
- **Do** define new colours in both themes and check WCAG AA in dark and light.
- **Do** honour `prefers-reduced-motion`: drop the light's drift and pulses, keep the
  colour change.
- **Do** give presses a small scale (0.96–0.97) and keep transitions at 0.08–0.25s; only
  the state light moves slowly (0.6s+).

### Don't:

- **Don't** use rainbow glows, neon saturation or multiple simultaneous light colours
  (gamer RGB).
- **Don't** add stat-tile grids, gradient hero cards or blue-purple gradients (generic SaaS
  dashboard).
- **Don't** make the Claude tab look like a chat app; the deck and approvals lead, the
  transcript supports.
- **Don't** add bevels, fake metal, textures or photographic materials (skeuomorphic
  chrome).
- **Don't** spread glass or blur beyond the deck, or put shadows on static content.
- **Don't** use state colours for decoration or fill a button with red.
