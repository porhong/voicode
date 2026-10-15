import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type SyntheticEvent,
} from 'react';

/**
 * How long a hold-to-confirm control must be held. A desk user approves by feel with
 * their eyes on the PC, so a tap that was meant for something else must never run a tool.
 */
export const ACCEPT_HOLD_MS = 600;

const buzz = (ms = 8) => navigator.vibrate?.(ms);

/**
 * Hold-to-confirm for a button that answers one approval: it acts only after it is held
 * for `ACCEPT_HOLD_MS`. Letting go early, or sliding the finger off, cancels; so does the
 * approval changing under the finger, because the press answers the request it was made
 * for and no other. Space and Enter hold the same way. Assistive technology activates
 * buttons with a bare click and no press to hold, so such a click (deliberate by nature,
 * and only reachable after moving focus onto the button) acts at once.
 *
 * Spread `handlers` on the button and draw the progress from `holding`.
 */
export function useHoldToConfirm({
  requestId,
  disabled,
  onConfirm,
  onEarly,
  onStart,
  onEnd,
}: {
  /** The approval the button would answer; a press is tied to it. */
  requestId: string | undefined;
  disabled: boolean;
  onConfirm: (requestId: string) => void;
  /** Released before the hold completed. */
  onEarly?: () => void;
  /** A hold began, and a hold ended (confirmed or not). */
  onStart?: () => void;
  onEnd?: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number>(undefined);
  const pressedFor = useRef<string>(undefined);
  const latest = useRef({ requestId, disabled, onConfirm, onEnd });
  useLayoutEffect(() => {
    latest.current = { requestId, disabled, onConfirm, onEnd };
  });

  const cancel = (early: boolean) => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    pressedFor.current = undefined;
    setHolding(false);
    onEnd?.();
    if (early) onEarly?.();
  };
  const start = () => {
    if (disabled || !requestId || timer.current !== undefined) return;
    pressedFor.current = requestId;
    setHolding(true);
    buzz();
    onStart?.();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const id = pressedFor.current;
      pressedFor.current = undefined;
      setHolding(false);
      const now = latest.current;
      now.onEnd?.();
      if (!id || now.disabled || now.requestId !== id) return;
      buzz(30);
      now.onConfirm(id);
    }, ACCEPT_HOLD_MS);
  };

  // A different approval, or the button going dark, ends any hold in progress.
  useEffect(() => {
    if (pressedFor.current && (disabled || pressedFor.current !== requestId)) cancel(false);
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const isHoldKey = (e: { key: string }) => e.key === ' ' || e.key === 'Enter';
  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start();
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (timer.current === undefined) return;
      const r = e.currentTarget.getBoundingClientRect();
      const off =
        e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (off) cancel(false);
    },
    onPointerUp: () => cancel(true),
    onPointerCancel: () => cancel(false),
    onLostPointerCapture: () => cancel(false),
    onContextMenu: (e: SyntheticEvent) => e.preventDefault(),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      if (!e.repeat) start();
    },
    onKeyUp: (e: KeyboardEvent<HTMLElement>) => {
      if (!isHoldKey(e)) return;
      e.preventDefault();
      cancel(true);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      // A pointer or key press is handled above; only assistive tech clicks with no press.
      if (e.detail !== 0 || timer.current !== undefined || disabled || !requestId) return;
      onConfirm(requestId);
    },
  };
  return { holding, handlers };
}
