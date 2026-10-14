import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DIRECTIONS, type DeckConfig, type Direction, type Macro } from '../hooks/useDeck';
import {
  orientationSupported,
  useOrientationLock,
  type OrientationChoice,
} from '../hooks/useOrientationLock';
import { DeckIcon, type DeckIconName } from './DeckIcons';
import { ArrowDownIcon, CollapseIcon, ExpandIcon, MicIcon, RotateIcon, StopIcon } from './Icons';

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
  /** The approval shown above the deck, which Accept and Reject answer. */
  approval?: { complete: boolean };
  micSupported: boolean;
  listening: boolean;
  /** The conversation is hidden and the deck has the screen to itself. */
  full: boolean;
  /** Claude's replies in this session, oldest first: the display reads them when full. */
  replies: string[];
  onToggleFull: () => void;
  onMacro: (macro: Macro) => void;
  onAccept: () => void;
  onReject: () => void;
  onStop: () => void;
  onNew: () => void;
  onType: () => void;
  onSessions: () => void;
  onCustomize: () => void;
  onPushToTalk: (pressed: boolean) => void;
  onScroll: (dy: number) => void;
  onLatest: () => void;
}

const buzz = (ms = 8) => navigator.vibrate?.(ms);

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

/**
 * The scroll dial: turn it (circular drag) to scroll the conversation, tap it to jump to
 * the latest output. Each detent gives a small buzz and a step, which the full-screen
 * deck uses to page through replies on its display.
 */
function Dial({
  hint,
  onScroll,
  onStep,
  onLatest,
  onHint,
}: {
  hint: string;
  onScroll: (dy: number) => void;
  onStep: (dir: 1 | -1) => void;
  onLatest: () => void;
  onHint: (text: string | undefined) => void;
}) {
  const [angle, setAngle] = useState(0);
  const drag = useRef<{ last: number; travel: number; start: number; detent: number }>(null);
  const DETENT = 24;
  /** Pixels scrolled per degree: one full turn ≈ two screens of text. */
  const PX_PER_DEG = 2.4;

  const pointerAngle = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return (
      (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) /
      Math.PI
    );
  };
  const turn = (degrees: number) => {
    setAngle((prev) => prev + degrees);
    onScroll(degrees * PX_PER_DEG);
  };

  return (
    <button
      className="deck-dial"
      style={{ gridArea: 'dial' }}
      aria-label={`Scroll dial. ${hint}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { last: pointerAngle(e), travel: 0, start: e.timeStamp, detent: 0 };
        onHint(hint);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const a = pointerAngle(e);
        // Unwrap across the ±180° seam.
        let delta = a - d.last;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        d.last = a;
        d.travel += Math.abs(delta);
        d.detent += delta;
        if (Math.abs(d.detent) >= DETENT) {
          buzz(4);
          onStep(d.detent > 0 ? 1 : -1);
          d.detent %= DETENT;
        }
        turn(delta);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        onHint(undefined);
        if (d && d.travel < 10 && e.timeStamp - d.start < 400) {
          buzz();
          onLatest();
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        onHint(undefined);
      }}
      onWheel={(e) => {
        turn(e.deltaY / PX_PER_DEG);
        onStep(e.deltaY > 0 ? 1 : -1);
      }}
      onKeyDown={(e) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key] as
          1 | -1 | undefined;
        if (step === undefined) return;
        e.preventDefault();
        turn((step * 120) / PX_PER_DEG);
        onStep(step);
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space) arrives as a click with no pointer.
        if (e.detail === 0) onLatest();
      }}
    >
      <span className="deck-dial-face" aria-hidden>
        <span className="deck-dial-marker" style={{ transform: `rotate(${angle}deg)` }} />
        <ArrowDownIcon size={18} />
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
      className={`deck-stick ${dir ? `deck-stick-${dir}` : ''} ${labelled ? 'labelled' : ''}`}
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

/** Auto / portrait / landscape, as a small menu under the rotate button. */
function RotateMenu({
  choice,
  onChoose,
  onClose,
}: {
  choice: OrientationChoice;
  onChoose: (next: OrientationChoice) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div className="deck-menu" role="menu" aria-label="Screen orientation" ref={ref}>
      {(['auto', 'portrait', 'landscape'] as const).map((value) => (
        <button
          key={value}
          role="menuitemradio"
          aria-checked={choice === value}
          className="deck-menu-item"
          onClick={() => onChoose(value)}
        >
          {ORIENTATION_TEXT[value]}
        </button>
      ))}
    </div>
  );
}

/**
 * The Claude tab as a macro pad, after Work Louder's Codex Micro but drawn flat: six
 * programmable keys, a scroll dial, a four-way pad, command keys (new, stop, reject,
 * accept) and a wide push-to-talk key on one sheet of glass. A light behind the glass
 * takes the session's state, and the display spells the state out, so colour is never
 * the only signal.
 *
 * The keys sit where a thumb reaches: talk and Accept along the bottom right, settings
 * and the dial up top. Accept and Reject answer the approval card shown above the deck,
 * which always carries the complete tool input (it stays on screen when the deck is
 * full); an incomplete one can only be rejected, as on the card.
 */
export function Deck(props: Props) {
  const { deck, status, canPrompt, connected, approval, full, replies } = props;
  const [hint, setHint] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [orientation, lockOrientation] = useOrientationLock();
  /**
   * How far back from the latest reply the display is (full deck only). It belongs to
   * the reply count it was set at, so a new reply brings the display back to it.
   */
  const [paged, setPaged] = useState<{ back: number; of: number }>();
  const back = paged?.of === replies.length ? paged.back : 0;

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
    setRotateOpen(false);
    const ok = await lockOrientation(next);
    setFlash(
      ok
        ? next === 'auto'
          ? 'Auto-rotate is on'
          : `Locked to ${next}`
        : "This browser can't lock rotation. Turn your phone instead.",
    );
  };

  const statusText =
    hint ?? flash ?? (props.listening ? 'Listening… release to send' : STATUS_TEXT[status]);
  const shown = Math.min(back, replies.length - 1);
  const reply = full && replies.length ? replies[replies.length - 1 - shown] : undefined;

  const macroKey = (macro: Macro, i: number) => (
    <Key
      key={i}
      area={`k${i + 1}`}
      className="deck-key-macro"
      label={macro.label || `Key ${i + 1}`}
      icon={<DeckIcon name={macro.icon} size={full ? 24 : 20} />}
      caption={macro.label}
      disabled={!connected}
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
            <span className="deck-display-text" role="status" aria-live="polite">
              {statusText}
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
            {orientationSupported() && (
              <span className="deck-tool-wrap">
                <button
                  className={`deck-tool ${orientation !== 'auto' ? 'on' : ''}`}
                  onClick={() => setRotateOpen((open) => !open)}
                  aria-label={`Screen orientation: ${ORIENTATION_TEXT[orientation]}`}
                  title="Screen orientation"
                  aria-haspopup="menu"
                  aria-expanded={rotateOpen}
                >
                  <RotateIcon />
                </button>
                {rotateOpen && (
                  <RotateMenu
                    choice={orientation}
                    onChoose={chooseOrientation}
                    onClose={() => setRotateOpen(false)}
                  />
                )}
              </span>
            )}
            <button
              className="deck-tool"
              onClick={props.onCustomize}
              aria-label="Customize deck"
              title="Customize deck"
            >
              <DeckIcon name="sliders" size={20} />
            </button>
          </div>
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
          <Dial
            hint={
              full
                ? 'Turn to read earlier replies · tap for the latest'
                : 'Turn to scroll · tap for the latest'
            }
            onScroll={props.onScroll}
            onStep={(dir) =>
              full &&
              setPaged({
                back: Math.max(0, Math.min(replies.length - 1, back - dir)),
                of: replies.length,
              })
            }
            onLatest={() => {
              setPaged(undefined);
              props.onLatest();
            }}
            onHint={setHint}
          />
          {deck.keys.slice(3).map((macro, i) => macroKey(macro, i + 3))}
          <Joystick
            stick={deck.stick}
            disabled={!connected}
            labelled={full}
            onFire={fireMacro}
            onHint={setHint}
          />

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
            label="Reject"
            icon={cmd('cross')}
            caption="Reject"
            lit={!!approval}
            disabled={!connected || !approval}
            onPress={props.onReject}
            onHint={setHint}
          />
          <Key
            area="accept"
            className="deck-key-cmd deck-key-accept"
            label="Accept"
            icon={cmd('check')}
            caption="Accept"
            lit={!!approval?.complete}
            disabled={!connected || !approval?.complete}
            onPress={props.onAccept}
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
