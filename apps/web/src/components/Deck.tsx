import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ACCEPT_HOLD_MS, useHoldToConfirm } from '../hooks/useHoldToConfirm';
import type { UsageReport } from '@voicecode/protocol';
import {
  DIRECTIONS,
  type DeckConfig,
  type DeckPad,
  type Direction,
  type Macro,
} from '../hooks/useDeck';
import {
  orientationSupported,
  useOrientationLock,
  type OrientationChoice,
} from '../hooks/useOrientationLock';
import { DeckIcon, type DeckIconName } from './DeckIcons';
import { UsagePad } from './UsagePad';
import { CollapseIcon, ExpandIcon, MicIcon, MoreIcon, StopIcon } from './Icons';

/** What the deck's light shows: the session on screen, roughly as the hardware does. */
export type DeckStatus =
  | 'none'
  | 'starting'
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'done'
  | 'error'
  | 'closed'
  | 'pc';

const STATUS_TEXT: Record<DeckStatus, string> = {
  none: 'No session — press New to start',
  starting: 'Starting…',
  idle: 'Ready',
  running: 'Claude is working…',
  awaiting_permission: 'Needs your approval',
  done: 'Done',
  error: 'Stopped with an error',
  closed: 'Session closed',
  pc: 'Viewing a terminal session',
};

const ARROW: Record<Direction, string> = { up: '↑', right: '→', down: '↓', left: '←' };

const ORIENTATION_TEXT: Record<OrientationChoice, string> = {
  auto: 'Auto-rotate',
  portrait: 'Portrait',
  landscape: 'Landscape',
};

interface Props {
  deck: DeckConfig;
  status: DeckStatus;
  /** Prompts can be sent (a live phone session, connected). */
  canPrompt: boolean;
  connected: boolean;
  running: boolean;
  /** The approval Accept and Reject answer: the first one waiting in this session. */
  approval?: DeckApproval;
  micSupported: boolean;
  listening: boolean;
  /** The conversation is hidden and the deck has the screen to itself. */
  full: boolean;
  /** Claude's replies in this session, oldest first: the display reads them when full. */
  replies: string[];
  /** The plan's usage limits, for the usage rings. */
  usage?: UsageReport;
  onToggleFull: () => void;
  onPadChange: (pad: DeckPad) => void;
  onUsage: () => void;
  onMacro: (macro: Macro) => void;
  /** Answers the approval with this request id (the one the display named). */
  onAccept: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onStop: () => void;
  onNew: () => void;
  onType: () => void;
  onSessions: () => void;
  onCustomize: () => void;
  onPushToTalk: (pressed: boolean) => void;
  onScroll: (dy: number) => void;
  onLatest: () => void;
}

/** What the deck needs to know about the approval it answers. */
export interface DeckApproval {
  requestId: string;
  toolName: string;
  /** The tool input, in full: the display shows its first line. */
  detail: string;
  /** False when the input was too long to review: it can then only be rejected. */
  complete: boolean;
  /** Which approval this is and how many are waiting in the session (1 of 3). */
  position: number;
  total: number;
}

/**
 * How long the command keys ignore presses after an approval arrives, so a tap landing
 * just as a key lights up never answers it. Accept is also held (`ACCEPT_HOLD_MS`).
 */
export const ARMING_MS = 500;
export { ACCEPT_HOLD_MS };

const buzz = (ms = 8) => navigator.vibrate?.(ms);

/** The tool input as one line for the display: its first non-empty line, trimmed. */
export function approvalSummary(detail: string): string {
  const line = detail.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * How many non-empty lines of the input the one-line summary leaves out, so the display
 * never passes off a multi-line command as its first line. The card shows them all.
 */
export function approvalMoreLines(detail: string, toolName?: string): number {
  const lines = detail.split('\n').filter((l) => l.trim());
  // The agent appends a Bash call's description as a trailing `# …` line: a shell
  // comment, which never runs, so it is not command the summary would be hiding.
  if (toolName === 'Bash' && lines.length > 1 && lines.at(-1)!.trimStart().startsWith('#')) {
    lines.pop();
  }
  return Math.max(0, lines.length - 1);
}

/** A reply as one plain line for the display: no code blocks or Markdown marks. */
export function plainReply(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function Key({
  area,
  className = '',
  label,
  icon,
  caption,
  disabled,
  lit,
  onPress,
  onHint,
}: {
  area: string;
  className?: string;
  label: string;
  icon: ReactNode;
  caption?: string;
  disabled?: boolean;
  lit?: boolean;
  onPress: () => void;
  onHint?: (text: string | undefined) => void;
}) {
  return (
    <button
      className={`deck-key ${className} ${lit ? 'lit' : ''}`}
      style={{ gridArea: area }}
      aria-label={label}
      disabled={disabled}
      onPointerDown={() => {
        buzz();
        onHint?.(label);
      }}
      onPointerUp={() => onHint?.(undefined)}
      onPointerLeave={() => onHint?.(undefined)}
      onClick={onPress}
    >
      {icon}
      {caption && <span className="deck-key-caption">{caption}</span>}
    </button>
  );
}

/** A key that acts only after it is held (`useHoldToConfirm`), as a fill rises inside it. */
function HoldKey({
  area,
  className = '',
  label,
  icon,
  caption,
  disabled,
  lit,
  requestId,
  onConfirm,
  onEarly,
  onHint,
}: {
  area: string;
  className?: string;
  label: string;
  icon: ReactNode;
  caption: string;
  disabled: boolean;
  lit: boolean;
  /** The approval this key would answer; a press is tied to it. */
  requestId?: string;
  onConfirm: (requestId: string) => void;
  onEarly: () => void;
  onHint: (text: string | undefined) => void;
}) {
  const { holding, handlers } = useHoldToConfirm({
    requestId,
    disabled,
    onConfirm,
    onEarly,
    onStart: () => onHint(`Keep holding to ${caption.toLowerCase()}…`),
    onEnd: () => onHint(undefined),
  });

  return (
    <button
      className={`deck-key deck-key-hold ${className} ${lit ? 'lit' : ''} ${holding ? 'holding' : ''}`}
      style={{ gridArea: area }}
      aria-label={label}
      disabled={disabled}
      {...handlers}
    >
      <span className="deck-hold-fill" aria-hidden />
      {icon}
      <span className="deck-key-caption">{caption}</span>
    </button>
  );
}

/**
 * The scroll wheel, drawn like a mouse wheel seen from above: swipe it to scroll the
 * conversation (a downward swipe shows later output, as rolling a mouse wheel back
 * does), flick it to let it spin on, tap it to jump to the latest. The ridges move
 * with the finger; each notch gives a small buzz and a step, which the full-screen
 * deck uses to page through replies (it spins only when scrolling).
 */
function Wheel({
  hint,
  momentum,
  onScroll,
  onStep,
  onLatest,
  onHint,
}: {
  hint: string;
  momentum: boolean;
  onScroll: (dy: number) => void;
  onStep: (dir: 1 | -1) => void;
  onLatest: () => void;
  onHint: (text: string | undefined) => void;
}) {
  const [offset, setOffset] = useState(0);
  const drag = useRef<{
    last: number;
    travel: number;
    start: number;
    at: number;
    velocity: number;
    stopped: boolean;
  }>(null);
  const notch = useRef(0);
  const spin = useRef(0);
  /** Finger travel per notch, and content pixels per pixel of finger travel. */
  const NOTCH = 22;
  const GAIN = 3;

  const stopSpin = () => {
    const spinning = spin.current !== 0;
    cancelAnimationFrame(spin.current);
    spin.current = 0;
    return spinning;
  };
  useEffect(() => () => cancelAnimationFrame(spin.current), []);

  const roll = (dy: number) => {
    setOffset((prev) => prev + dy);
    onScroll(dy * GAIN);
    notch.current += dy;
    if (Math.abs(notch.current) >= NOTCH) {
      buzz(3);
      onStep(notch.current > 0 ? 1 : -1);
      notch.current %= NOTCH;
    }
  };

  return (
    <button
      className="deck-wheel"
      style={{ gridArea: 'wheel' }}
      aria-label={`Scroll wheel. ${hint}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        // Touching a spinning wheel stops it, and that touch is not a tap.
        const stopped = stopSpin();
        drag.current = {
          last: e.clientY,
          travel: 0,
          start: e.timeStamp,
          at: e.timeStamp,
          velocity: 0,
          stopped,
        };
        onHint(hint);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.last;
        const dt = Math.max(1, e.timeStamp - d.at);
        d.last = e.clientY;
        d.at = e.timeStamp;
        d.travel += Math.abs(dy);
        d.velocity = 0.8 * (dy / dt) + 0.2 * d.velocity;
        if (dy) roll(dy);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        onHint(undefined);
        if (!d) return;
        if (d.travel < 6 && e.timeStamp - d.start < 350 && !d.stopped) {
          buzz();
          onLatest();
          return;
        }
        // A flick keeps the wheel turning and slowing, like a free-spinning mouse wheel.
        let v = e.timeStamp - d.at < 80 ? d.velocity * 16 : 0;
        if (!momentum || Math.abs(v) < 4) return;
        const tick = () => {
          v *= 0.94;
          if (Math.abs(v) < 0.6) {
            spin.current = 0;
            return;
          }
          roll(v);
          spin.current = requestAnimationFrame(tick);
        };
        spin.current = requestAnimationFrame(tick);
      }}
      onPointerCancel={() => {
        drag.current = null;
        onHint(undefined);
      }}
      onWheel={(e) => roll(e.deltaY / GAIN)}
      onKeyDown={(e) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
        if (step === undefined) return;
        e.preventDefault();
        roll(step * NOTCH);
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space) arrives as a click with no pointer.
        if (e.detail === 0) onLatest();
      }}
    >
      <span className="deck-wheel-track" aria-hidden>
        <span className="deck-wheel-ridges" style={{ backgroundPositionY: `${offset}px` }} />
      </span>
    </button>
  );
}

/**
 * Four-way pad with programmable pushes. Drag the thumb in a direction and let go to
 * fire; while pushed, the display names what will happen, so a wrong push can be
 * cancelled by sliding back to the centre. Each direction is also a plain button.
 */
function Joystick({
  stick,
  disabled,
  labelled,
  onFire,
  onHint,
}: {
  stick: DeckConfig['stick'];
  disabled: boolean;
  /** Room to print each direction's name next to its arrow. */
  labelled: boolean;
  onFire: (macro: Macro) => void;
  onHint: (text: string | undefined) => void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dir, setDir] = useState<Direction>();
  const origin = useRef<{ x: number; y: number; travel: number }>(null);
  const TRIGGER = 14;

  const legend = DIRECTIONS.map((d) => `${ARROW[d]} ${stick[d].label}`).join('  ');
  const describe = (d: Direction | undefined) =>
    d ? `${ARROW[d]} ${stick[d].label} — release to send` : legend;

  const end = (fire: boolean) => {
    if (fire && dir && !disabled) {
      buzz(14);
      onFire(stick[dir]);
    }
    origin.current = null;
    setOffset({ x: 0, y: 0 });
    setDir(undefined);
    onHint(undefined);
  };

  return (
    <div
      className={`deck-stick ${dir ? `deck-stick-${dir}` : ''} ${labelled ? 'labelled' : ''} ${disabled ? 'off' : ''}`}
      style={{ gridArea: 'stick' }}
      role="group"
      aria-label={`Joystick: ${legend}`}
    >
      <span
        className="deck-stick-base"
        aria-hidden
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const r = e.currentTarget.getBoundingClientRect();
          origin.current = { x: e.clientX, y: e.clientY, travel: r.width * 0.26 };
          onHint(legend);
        }}
        onPointerMove={(e) => {
          const o = origin.current;
          if (!o) return;
          let x = e.clientX - o.x;
          let y = e.clientY - o.y;
          const dist = Math.hypot(x, y);
          if (dist > o.travel) {
            x = (x / dist) * o.travel;
            y = (y / dist) * o.travel;
          }
          setOffset({ x, y });
          const next: Direction | undefined =
            dist < TRIGGER
              ? undefined
              : Math.abs(x) > Math.abs(y)
                ? x > 0
                  ? 'right'
                  : 'left'
                : y > 0
                  ? 'down'
                  : 'up';
          if (next !== dir) {
            if (next) buzz(6);
            setDir(next);
            onHint(describe(next));
          }
        }}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
      >
        <span
          className="deck-stick-thumb"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        />
      </span>
      {DIRECTIONS.map((d) => (
        <button
          key={d}
          className={`deck-stick-dir deck-stick-dir-${d}`}
          aria-label={`${stick[d].label} (joystick ${d})`}
          disabled={disabled}
          onClick={() => {
            buzz();
            onFire(stick[d]);
          }}
        >
          <span aria-hidden>{ARROW[d]}</span>
          {labelled && <span className="deck-stick-label">{stick[d].label}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The display's "more" menu: what the pad shows, the screen orientation (where the
 * browser can lock it) and the deck editor. They change rarely, so they live one tap
 * away and leave the display bar to the status.
 */
function DeckMenu({
  pad,
  orientation,
  onPad,
  onOrientation,
  onCustomize,
  onClose,
}: {
  pad: DeckPad;
  /** Undefined where the orientation can't be locked: the choices are left out. */
  orientation?: OrientationChoice;
  onPad: (pad: DeckPad) => void;
  onOrientation: (next: OrientationChoice) => void;
  onCustomize: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The deck re-renders on every server message: keep the latest close without re-running
  // the effect, which would pull focus back to the first item each time.
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const menu = ref.current;
    menu?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!menu?.parentElement?.contains(e.target as Node)) close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Back to the button that opened it, so the keyboard isn't left nowhere.
      menu?.parentElement?.querySelector<HTMLElement>('.deck-tool')?.focus();
      close.current();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, []);

  /** Arrow keys, Home and End move through the items, as in any menu. */
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step === undefined && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (step ?? 0) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="deck-menu" role="menu" aria-label="Deck options" ref={ref} onKeyDown={move}>
      <span className="deck-menu-label" id="deck-menu-pad" aria-hidden>
        Pad
      </span>
      <div className="deck-menu-seg" role="group" aria-labelledby="deck-menu-pad">
        {(['stick', 'usage'] as const).map((value) => (
          <button
            key={value}
            role="menuitemradio"
            aria-checked={pad === value}
            className="deck-menu-choice"
            onClick={() => onPad(value)}
          >
            {value === 'stick' ? 'Joystick' : 'Usage'}
          </button>
        ))}
      </div>
      {orientation && (
        <>
          <span className="deck-menu-label" id="deck-menu-rotate" aria-hidden>
            Screen
          </span>
          <div className="deck-menu-seg" role="group" aria-labelledby="deck-menu-rotate">
            {(['auto', 'portrait', 'landscape'] as const).map((value) => (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={orientation === value}
                aria-label={ORIENTATION_TEXT[value]}
                className="deck-menu-choice"
                onClick={() => onOrientation(value)}
              >
                {value === 'auto' ? 'Auto' : ORIENTATION_TEXT[value]}
              </button>
            ))}
          </div>
        </>
      )}
      <span className="deck-menu-rule" aria-hidden />
      <button role="menuitem" className="deck-menu-item" onClick={onCustomize}>
        Customize deck…
      </button>
    </div>
  );
}

/**
 * The Claude tab as a macro pad, after Work Louder's Codex Micro but drawn flat: six
 * programmable keys, a scroll wheel, a four-way pad, command keys (new, stop, reject,
 * accept) and a wide push-to-talk key on one sheet of glass. A light behind the glass
 * takes the session's state, and the display spells the state out, so colour is never
 * the only signal.
 *
 * The keys sit where a thumb reaches: talk and Accept along the bottom, the wheel and
 * the pad down the right edge, settings on the display up top. Accept and Reject answer
 * the approval the display names (tool, first line of input, "1 of 3"); the card above
 * the deck still carries the complete input and stays on screen when the deck is full.
 * Both keys wait `ARMING_MS` after an approval arrives, Accept must be held, and an
 * incomplete approval can only be rejected, as on the card.
 */
export function Deck(props: Props) {
  const { deck, status, canPrompt, connected, approval, full, replies } = props;
  const [hint, setHint] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [orientation, lockOrientation] = useOrientationLock();
  /**
   * How far back from the latest reply the display is (full deck only). It belongs to
   * the reply count it was set at, so a new reply brings the display back to it.
   */
  const [paged, setPaged] = useState<{ back: number; of: number }>();
  const back = paged?.of === replies.length ? paged.back : 0;
  /** The approval whose command keys are live: each new one waits `ARMING_MS` first. */
  const [armedFor, setArmedFor] = useState<string>();
  const approvalId = approval?.requestId;
  const armed = !!approvalId && armedFor === approvalId;

  useEffect(() => {
    if (!approvalId) return;
    const timer = window.setTimeout(() => setArmedFor(approvalId), ARMING_MS);
    return () => window.clearTimeout(timer);
  }, [approvalId]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(undefined), 1800);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const fireMacro = (macro: Macro) => {
    if (!macro.prompt.trim()) {
      setFlash(`“${macro.label}” has no prompt yet — customize it`);
      return;
    }
    if (!canPrompt) {
      setFlash('Start a session first');
      return;
    }
    setFlash(macro.review ? `${macro.label}: edit, then send` : `Sent: ${macro.label}`);
    props.onMacro(macro);
  };

  const chooseOrientation = async (next: OrientationChoice) => {
    setMenuOpen(false);
    const ok = await lockOrientation(next);
    setFlash(
      ok
        ? next === 'auto'
          ? 'Auto-rotate is on'
          : `Locked to ${next}`
        : "This browser can't lock rotation. Turn your phone instead.",
    );
  };

  // With an approval waiting, the status says how to answer it (the display row names it).
  const approvalText = approval
    ? approval.complete
      ? 'Hold Accept to allow'
      : 'Too long to review: reject only'
    : undefined;
  /** What the session is doing: it stays the same while keys are pressed. */
  const stateText = props.listening
    ? 'Listening… release to send'
    : (approvalText ?? STATUS_TEXT[status]);
  /** A key's name while it is pressed, or a moment's feedback, shown over the state. */
  const momentText = hint ?? flash;
  const shown = Math.min(back, replies.length - 1);
  // While an approval waits it takes the display: the reply can be read after.
  const reply =
    full && replies.length && !approval ? replies[replies.length - 1 - shown] : undefined;
  const summary = approval ? approvalSummary(approval.detail) : '';
  const moreLines = approval ? approvalMoreLines(approval.detail, approval.toolName) : 0;
  const moreText = moreLines ? `+${moreLines} line${moreLines > 1 ? 's' : ''}` : '';
  /** What Accept and Reject name for screen readers: the whole extent, not just line one. */
  const spoken = `${summary}${moreLines ? `, and ${moreLines} more line${moreLines > 1 ? 's' : ''} on the card` : ''}`;
  const tool = approval?.toolName ?? '';
  /**
   * The answer, named, for a moment after it is given: the 30ms buzz is easy to miss with
   * the phone on the desk, and the approval row disappears as Claude carries on.
   */
  const answeredText = (verb: 'Allowed' | 'Rejected') =>
    [`${verb}: ${tool}`, summary && ` · ${summary}`, moreText && ` ${moreText}`].join('');

  /**
   * An approval is waiting: the programmable keys and the pad go dark until it is
   * answered, so a thumb reaching for Reject or Accept cannot send "Commit" instead.
   * They keep their places; Stop, the answer keys, talk, Type and Sessions stay live.
   */
  const waiting = !!approval;
  const macroKey = (macro: Macro, i: number) => (
    <Key
      key={i}
      area={`k${i + 1}`}
      className="deck-key-macro"
      label={macro.label || `Key ${i + 1}`}
      icon={<DeckIcon name={macro.icon} size={full ? 24 : 20} />}
      caption={macro.label}
      disabled={!connected || waiting}
      onPress={() => fireMacro(macro)}
      onHint={setHint}
    />
  );
  const cmd = (name: DeckIconName) => <DeckIcon name={name} size={full ? 24 : 21} />;

  return (
    <section
      className={`deck-wrap ${full ? 'deck-full' : ''}`}
      data-status={status}
      data-listening={props.listening || undefined}
      aria-label="Deck"
    >
      <div className="deck-light" aria-hidden />
      <div className="deck">
        <div className="deck-display">
          <div className="deck-display-bar">
            <span className="deck-led" aria-hidden />
            {/*
              Two live regions that always exist (a region added with its text may not be
              read): the state, announced when it changes, and feedback such as "Allowed: …".
              A pressed key's name is shown only: screen readers already have the key's label.
            */}
            <span className="deck-display-text">
              <span role="status" className={momentText ? 'visually-hidden' : undefined}>
                {stateText}
              </span>
              {momentText && (
                <span className="deck-display-moment" aria-hidden>
                  {momentText}
                </span>
              )}
              <span className="visually-hidden" role="status">
                {flash ?? ''}
              </span>
            </span>
            <button
              className="deck-tool"
              onClick={props.onToggleFull}
              aria-label={full ? 'Show the conversation' : 'Hide the conversation'}
              title={full ? 'Show the conversation' : 'Hide the conversation'}
              aria-pressed={full}
            >
              {full ? <CollapseIcon /> : <ExpandIcon />}
            </button>
            <span className="deck-tool-wrap">
              <button
                className="deck-tool"
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="Deck options"
                title="Deck options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <MoreIcon />
              </button>
              {menuOpen && (
                <DeckMenu
                  pad={deck.pad}
                  orientation={orientationSupported() ? orientation : undefined}
                  onPad={(next) => {
                    setMenuOpen(false);
                    if (next === deck.pad) return;
                    props.onPadChange(next);
                    setFlash(next === 'usage' ? 'Showing usage limits' : 'Showing the joystick');
                  }}
                  onOrientation={chooseOrientation}
                  onCustomize={() => {
                    setMenuOpen(false);
                    props.onCustomize();
                  }}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </span>
          </div>
          {approval && (
            <div className="deck-approval">
              <span className="deck-approval-tool">{tool}</span>
              <code className="deck-approval-summary">{summary || '(no input)'}</code>
              {moreText && <span className="deck-approval-more">{moreText}</span>}
              {approval.total > 1 && (
                <span className="deck-approval-count">
                  {approval.position} of {approval.total}
                </span>
              )}
            </div>
          )}
          {full && !approval && deck.pad === 'stick' && (
            // The pad keeps its small place in the strip, so its four names live here.
            // Screen readers get them from the joystick's own label.
            <p className="deck-legend" aria-hidden>
              {DIRECTIONS.map((d) => (
                <span key={d} className="deck-legend-item">
                  {ARROW[d]} {deck.stick[d].label || 'Not set'}
                </span>
              ))}
            </p>
          )}
          {reply !== undefined && (
            <button
              className="deck-reply"
              onClick={props.onToggleFull}
              aria-label={`Claude's reply ${replies.length - shown} of ${replies.length}. Show the conversation.`}
            >
              <span className="deck-reply-meta" aria-hidden>
                {shown === 0
                  ? 'Latest reply'
                  : `Reply ${replies.length - shown} of ${replies.length}`}
              </span>
              <span className="deck-reply-text">{plainReply(reply)}</span>
            </button>
          )}
        </div>

        <div className="deck-grid">
          {deck.keys.slice(0, 3).map(macroKey)}
          <Wheel
            hint={
              full
                ? 'Swipe to read earlier replies · tap for the latest'
                : 'Swipe to scroll · tap for the latest'
            }
            momentum={!full}
            onScroll={props.onScroll}
            onStep={(dir) =>
              full &&
              setPaged((prev) => {
                const from = prev?.of === replies.length ? prev.back : 0;
                return {
                  back: Math.max(0, Math.min(replies.length - 1, from - dir)),
                  of: replies.length,
                };
              })
            }
            onLatest={() => {
              setPaged(undefined);
              props.onLatest();
            }}
            onHint={setHint}
          />
          {deck.keys.slice(3).map((macro, i) => macroKey(macro, i + 3))}
          {deck.pad === 'usage' ? (
            <UsagePad
              usage={props.usage}
              connected={connected}
              disabled={waiting}
              onOpen={props.onUsage}
              onHint={setHint}
            />
          ) : (
            <Joystick
              stick={deck.stick}
              disabled={!connected || waiting}
              labelled={full}
              onFire={fireMacro}
              onHint={setHint}
            />
          )}

          <Key
            area="new"
            className="deck-key-cmd"
            label="New session"
            icon={cmd('branch')}
            caption="New"
            disabled={!connected}
            onPress={props.onNew}
            onHint={setHint}
          />
          <Key
            area="stop"
            className="deck-key-cmd deck-key-stop"
            label="Stop Claude"
            icon={<StopIcon size={full ? 20 : 18} />}
            caption="Stop"
            lit={props.running}
            disabled={!connected || !props.running}
            onPress={props.onStop}
            onHint={setHint}
          />
          <Key
            area="reject"
            className="deck-key-cmd deck-key-reject"
            label={approval ? `Reject ${tool}: ${spoken}` : 'Reject'}
            icon={cmd('cross')}
            caption="Reject"
            lit={armed}
            disabled={!connected || !armed}
            onPress={() => {
              if (!approvalId) return;
              props.onReject(approvalId);
              setFlash(answeredText('Rejected'));
            }}
            onHint={(text) => setHint(text && 'Reject')}
          />
          <HoldKey
            area="accept"
            className="deck-key-cmd deck-key-accept"
            label={
              approval?.complete
                ? `Hold to accept ${tool}: ${spoken}`
                : 'Accept (needs a complete approval)'
            }
            icon={cmd('check')}
            caption="Accept"
            requestId={approvalId}
            lit={armed && !!approval?.complete}
            disabled={!connected || !armed || !approval?.complete}
            onConfirm={(id) => {
              props.onAccept(id);
              setFlash(answeredText('Allowed'));
            }}
            onEarly={() => setFlash('Too quick: hold Accept until it fills')}
            onHint={setHint}
          />

          <Key
            area="type"
            className="deck-key-cmd"
            label="Type a prompt"
            icon={cmd('keyboard')}
            caption="Type"
            disabled={!canPrompt}
            onPress={props.onType}
            onHint={setHint}
          />
          <button
            className={`deck-key deck-key-mic ${props.listening ? 'lit' : ''}`}
            style={{ gridArea: 'mic' }}
            aria-label={
              props.micSupported ? 'Hold to talk' : 'Type a prompt (dictation unavailable)'
            }
            aria-pressed={props.listening}
            disabled={!canPrompt}
            onPointerDown={(e) => {
              if (!props.micSupported) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              buzz(12);
              props.onPushToTalk(true);
            }}
            onPointerUp={() => props.micSupported && props.onPushToTalk(false)}
            onPointerCancel={() => props.micSupported && props.onPushToTalk(false)}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && props.micSupported) {
                e.preventDefault();
                props.onPushToTalk(true);
              }
            }}
            onKeyUp={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && props.micSupported) {
                e.preventDefault();
                props.onPushToTalk(false);
              }
            }}
            onClick={() => !props.micSupported && props.onType()}
          >
            <MicIcon size={full ? 26 : 22} />
            <span className="deck-key-caption">
              {props.micSupported ? (props.listening ? 'Release to send' : 'Hold to talk') : 'Type'}
            </span>
          </button>
          <Key
            area="sessions"
            className="deck-key-cmd"
            label="Sessions"
            icon={cmd('layers')}
            caption="Sessions"
            onPress={props.onSessions}
            onHint={setHint}
          />
        </div>
      </div>
    </section>
  );
}
