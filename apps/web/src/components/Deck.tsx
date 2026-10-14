import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DIRECTIONS, type DeckConfig, type Direction, type Macro } from '../hooks/useDeck';
import { DeckIcon, type DeckIconName } from './DeckIcons';
import { MicIcon, StopIcon } from './Icons';

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

function Key({
  className = '',
  label,
  icon,
  caption,
  disabled,
  lit,
  onPress,
  onHint,
}: {
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
      <span className="deck-key-cap">
        {icon}
        {caption && <span className="deck-key-caption">{caption}</span>}
      </span>
    </button>
  );
}

/**
 * The rotary dial: turn it (circular drag) to scroll the conversation, tap it to jump to
 * the latest output. A small buzz marks each detent, like the hardware's clicks.
 */
function Dial({
  onScroll,
  onLatest,
  onHint,
}: {
  onScroll: (dy: number) => void;
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

  return (
    <button
      className="deck-dial"
      aria-label="Scroll dial. Turn to scroll the conversation, tap for the latest."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { last: pointerAngle(e), travel: 0, start: e.timeStamp, detent: 0 };
        onHint('Turn to scroll · tap for latest');
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
          d.detent %= DETENT;
        }
        setAngle((prev) => prev + delta);
        onScroll(delta * PX_PER_DEG);
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
        setAngle((prev) => prev + e.deltaY / PX_PER_DEG);
        onScroll(e.deltaY);
      }}
      onKeyDown={(e) => {
        const step = { ArrowDown: 120, ArrowRight: 120, ArrowUp: -120, ArrowLeft: -120 }[e.key];
        if (step === undefined) return;
        e.preventDefault();
        setAngle((prev) => prev + step / PX_PER_DEG);
        onScroll(step);
      }}
      onClick={(e) => {
        // Keyboard activation (Enter/Space) arrives as a click with no pointer.
        if (e.detail === 0) onLatest();
      }}
    >
      <span className="deck-dial-ring" aria-hidden />
      <span className="deck-dial-knob" style={{ transform: `rotate(${angle}deg)` }} aria-hidden>
        <span className="deck-dial-notch" />
      </span>
    </button>
  );
}

/**
 * Planar joystick with four programmable pushes. Push in a direction and let go to
 * fire; while pushed, the display names what will happen, so a wrong push can be
 * cancelled by sliding back to the centre.
 */
function Joystick({
  stick,
  disabled,
  onFire,
  onHint,
}: {
  stick: DeckConfig['stick'];
  disabled: boolean;
  onFire: (macro: Macro) => void;
  onHint: (text: string | undefined) => void;
}) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dir, setDir] = useState<Direction>();
  const origin = useRef<{ x: number; y: number }>(null);
  const TRAVEL = 18;
  const TRIGGER = 12;

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
      className={`deck-stick ${dir ? `deck-stick-${dir}` : ''}`}
      role="group"
      aria-label={`Joystick: ${legend}`}
    >
      {DIRECTIONS.map((d) => (
        // Tappable labels double as the accessible way to fire each direction.
        <button
          key={d}
          className={`deck-stick-arrow deck-stick-arrow-${d}`}
          aria-label={`${stick[d].label} (joystick ${d})`}
          disabled={disabled}
          onClick={() => {
            buzz();
            onFire(stick[d]);
          }}
        >
          <span aria-hidden>{ARROW[d]}</span>
        </button>
      ))}
      <span
        className="deck-stick-base"
        aria-hidden
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          origin.current = { x: e.clientX, y: e.clientY };
          onHint(legend);
        }}
        onPointerMove={(e) => {
          const o = origin.current;
          if (!o) return;
          let x = e.clientX - o.x;
          let y = e.clientY - o.y;
          const dist = Math.hypot(x, y);
          if (dist > TRAVEL) {
            x = (x / dist) * TRAVEL;
            y = (y / dist) * TRAVEL;
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
          className="deck-stick-knob"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        />
      </span>
    </div>
  );
}

/**
 * The Claude tab as a macro pad, after Work Louder's Codex Micro: six programmable keys,
 * a scroll dial, a four-way joystick, command keys (stop, accept, reject, new) and a
 * wide push-to-talk key. The frame glows with the session's state.
 *
 * Accept and Reject answer the approval card shown above the deck, which always carries
 * the complete tool input; an incomplete one can only be rejected, as on the card.
 */
export function Deck(props: Props) {
  const { deck, status, canPrompt, connected, approval } = props;
  const [hint, setHint] = useState<string>();
  const [flash, setFlash] = useState<string>();

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(undefined), 1600);
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
    setFlash(macro.review ? `${macro.label} → edit, then send` : `Sent: ${macro.label}`);
    props.onMacro(macro);
  };

  const display =
    hint ?? flash ?? (props.listening ? 'Listening… release to send' : STATUS_TEXT[status]);

  const macroKey = (macro: Macro, i: number) => (
    <Key
      key={i}
      className="deck-key-macro"
      label={macro.label || `Key ${i + 1}`}
      icon={<DeckIcon name={macro.icon} size={20} />}
      caption={macro.label}
      disabled={!connected}
      onPress={() => fireMacro(macro)}
      onHint={setHint}
    />
  );
  const cmd = (name: DeckIconName) => <DeckIcon name={name} size={22} />;

  return (
    <section className="deck" data-status={status} aria-label="Deck">
      <div className="deck-display" role="status" aria-live="polite">
        <span className="deck-led" aria-hidden />
        <span className="deck-display-text">{display}</span>
        <button
          className="deck-display-btn"
          onClick={props.onCustomize}
          aria-label="Customize deck"
        >
          <DeckIcon name="sliders" size={18} />
        </button>
      </div>
      <div className="deck-grid">
        <Dial onScroll={props.onScroll} onLatest={props.onLatest} onHint={setHint} />
        {deck.keys.slice(0, 2).map(macroKey)}
        <Joystick stick={deck.stick} disabled={!connected} onFire={fireMacro} onHint={setHint} />
        {deck.keys.slice(2).map((macro, i) => macroKey(macro, i + 2))}

        <Key
          className="deck-key-cmd deck-key-stop"
          label="Stop Claude"
          icon={<StopIcon size={18} />}
          caption="Stop"
          lit={props.running}
          disabled={!connected || !props.running}
          onPress={props.onStop}
          onHint={setHint}
        />
        <Key
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
          className="deck-key-cmd"
          label="New session"
          icon={cmd('branch')}
          caption="New"
          disabled={!connected}
          onPress={props.onNew}
          onHint={setHint}
        />

        <Key
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
          aria-label={props.micSupported ? 'Hold to talk' : 'Type a prompt (dictation unavailable)'}
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
          <span className="deck-key-cap">
            <MicIcon size={22} />
            <span className="deck-key-caption">
              {props.micSupported ? (props.listening ? 'Release to send' : 'Hold to talk') : 'Type'}
            </span>
          </span>
        </button>
        <Key
          className="deck-key-cmd"
          label="Sessions"
          icon={cmd('layers')}
          caption="Sessions"
          onPress={props.onSessions}
          onHint={setHint}
        />
      </div>
    </section>
  );
}
