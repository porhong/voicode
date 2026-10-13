import { useEffect, useMemo } from 'react';
import type { MouseButton } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import type { Settings } from '../hooks/useSettings';
import { InputBatcher } from '../lib/input-batcher';
import type { AppState } from '../lib/store';
import { TrackpadGestures } from '../lib/trackpad';

interface Props {
  /** False while reconnecting; input would be dropped, so the pad is paused. */
  connected: boolean;
  send: Send;
  mouse: AppState['mouse'];
  settings: Settings;
}

function haptic(): void {
  navigator.vibrate?.(8);
}

/** Full-screen trackpad plus press-and-hold mouse buttons. */
export function Trackpad({ send, mouse, settings, connected }: Props) {
  const { batcher, gestures } = useMemo(() => {
    const batcher = new InputBatcher(send, haptic);
    return { batcher, gestures: new TrackpadGestures(batcher) };
  }, [send]);

  useEffect(() => {
    gestures.configure(settings);
  }, [gestures, settings]);

  useEffect(
    () => () => {
      gestures.reset();
      batcher.dispose();
    },
    [gestures, batcher],
  );

  // The pad unmounts while disconnected or when the mouse is unavailable, so fingers
  // that were down never deliver pointerup; forget them so new touches start clean.
  useEffect(() => {
    if (!connected || !mouse.status.available) gestures.reset();
  }, [connected, mouse.status.available, gestures]);

  const holder = mouse.status.holder;
  const heldByOther = !mouse.youHoldLease && holder !== undefined;

  // Input sent before the lease is granted is rejected by the agent; the acquire
  // round trip is a few milliseconds, so at most the first frame of a swipe is lost.
  const ensureLease = () => {
    if (!mouse.youHoldLease && !heldByOther) send({ type: 'mouse.acquire' });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ensureLease();
    gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Coalesced events give the full-resolution path on browsers that batch moves.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      gestures.move(e.pointerId, ev.clientX, ev.clientY, ev.timeStamp);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) =>
    gestures.up(e.pointerId, e.timeStamp, e.type === 'pointercancel');

  const pressHandlers = (button: MouseButton) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      ensureLease();
      batcher.buttonDown(button);
    },
    onPointerUp: () => batcher.buttonUp(button),
    onPointerCancel: () => batcher.buttonUp(button),
  });

  if (!connected) {
    return (
      <div className="trackpad-unavailable">
        <p className="muted">Connecting to the agent…</p>
      </div>
    );
  }

  if (!mouse.status.available) {
    return (
      <div className="trackpad-unavailable">
        <p className="muted">Mouse control is unavailable on the PC.</p>
        {mouse.status.reason && <p className="small muted">{mouse.status.reason}</p>}
      </div>
    );
  }

  return (
    <div className="trackpad-layout">
      {heldByOther && (
        <div className="lease-banner">
          <span>Controlled by {holder.deviceName}</span>
          <button
            className="btn btn-small"
            onClick={() => send({ type: 'mouse.acquire', force: true })}
          >
            Take control
          </button>
        </div>
      )}
      <div
        className={`trackpad ${mouse.youHoldLease ? 'active' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={(e) => gestures.up(e.pointerId, e.timeStamp, true)}
        onContextMenu={(e) => e.preventDefault()}
        role="application"
        aria-label="Trackpad"
      >
        <span className="trackpad-hint">
          Tap to click · two-finger tap for right click · two fingers to scroll · tap then drag to
          select
        </span>
      </div>
      <div className="mouse-buttons">
        <button className="mouse-button" {...pressHandlers('left')} aria-label="Left button">
          L
        </button>
        <button className="mouse-button" {...pressHandlers('middle')} aria-label="Middle button">
          M
        </button>
        <button className="mouse-button" {...pressHandlers('right')} aria-label="Right button">
          R
        </button>
      </div>
    </div>
  );
}
