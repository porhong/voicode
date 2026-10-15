import { useLayoutEffect, useRef, useState } from 'react';
import type { UsageLimit, UsageReport } from '@voicecode/protocol';
import { describeLimit, percentText, resetsIn, tightest, usageLevel } from '../lib/usage';

/** Below this a ring's number is hard to read; fewer, larger rings are drawn instead. */
const MIN_RING = 34;
const MAX_RING = 104;
const GAP = 6;
/** Room under a ring for its name, and for its reset time when there is more space. */
const NAME_H = 14;
const RESET_H = 14;

interface Layout {
  shown: UsageLimit[];
  cols: number;
  ring: number;
  withReset: boolean;
}

/**
 * How many rings fit the pad's box, and how big: every column count is tried and the
 * one giving the largest rings wins. `limits` comes in priority order (see `padLimits`:
 * 5-hour session, week, then models); when not all fit, the first ones are kept and the
 * rest are counted, so the 5-hour ring is never the one that disappears.
 */
export function layoutRings(limits: UsageLimit[], w: number, h: number): Layout {
  for (let k = limits.length; k >= 1; k--) {
    const shown = limits.slice(0, k);
    let best: Layout | undefined;
    for (let cols = 1; cols <= k; cols++) {
      const rows = Math.ceil(k / cols);
      const cellW = (w - (cols - 1) * GAP) / cols;
      const cellH = (h - (rows - 1) * GAP) / rows;
      const ring = Math.min(MAX_RING, cellW, cellH - NAME_H);
      const withReset = cellH - ring >= NAME_H + RESET_H && ring >= 56;
      if (!best || ring > best.ring) best = { shown, cols, ring, withReset };
    }
    if (best && best.ring >= MIN_RING) return best;
  }
  return { shown: [], cols: 1, ring: 0, withReset: false };
}

function Ring({ limit, size, withReset }: { limit: UsageLimit; size: number; withReset: boolean }) {
  const r = 20;
  const circumference = 2 * Math.PI * r;
  const used = limit.utilization ?? 0;
  return (
    <span className="usage-cell" data-level={usageLevel(limit.utilization)}>
      <span className="usage-ring" style={{ width: size, height: size }}>
        <svg viewBox="0 0 48 48" aria-hidden>
          <circle className="usage-track" cx="24" cy="24" r={r} />
          {limit.utilization !== null && (
            <circle
              className="usage-arc"
              cx="24"
              cy="24"
              r={r}
              strokeDasharray={`${(used / 100) * circumference} ${circumference}`}
            />
          )}
        </svg>
        <span className="usage-pct" style={{ fontSize: Math.max(11, size * 0.27) }}>
          {percentText(limit.utilization)}
        </span>
      </span>
      <span className="usage-name">{limit.short}</span>
      {withReset && limit.resetsAt !== null && (
        <span className="usage-reset">{resetsIn(limit.resetsAt).replace(/^in /, '')}</span>
      )}
    </span>
  );
}

/** The pad's order: the 5-hour session first, then the week, then each model's week. */
const PAD_ORDER: Partial<Record<UsageLimit['scope'], number>> = { session: 0, week: 1, model: 2 };

/**
 * The limits the pad shows, in this order: the subscription's 5-hour session, its weekly
 * limit, then the weekly limit of each model that has one (e.g. Fable). App and
 * extra-usage limits are in the details sheet (the pad counts them as "+n more").
 * Everything is shown when the plan reports none of these.
 */
export function padLimits(limits: UsageLimit[]): UsageLimit[] {
  const primary = limits
    .filter((l) => PAD_ORDER[l.scope] !== undefined)
    .sort((a, b) => PAD_ORDER[a.scope]! - PAD_ORDER[b.scope]!);
  return primary.length ? primary : limits;
}

/**
 * The plan's usage limits on the deck, in the joystick's place: the 5-hour session and
 * the week, one ring each. The limits are separate budgets,
 * not shares of one whole, so each gets its own ring rather than a slice of one pie.
 * A ring turns amber from 75 % and red from 90 %; the numbers say the same in text.
 * Tap for the details sheet.
 */
export function UsagePad({
  usage,
  connected,
  disabled = false,
  onOpen,
  onHint,
}: {
  usage?: UsageReport;
  connected: boolean;
  /** Dark while an approval waits, like the programmable keys. */
  disabled?: boolean;
  onOpen: () => void;
  onHint: (text: string | undefined) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setBox({ w: el.clientWidth - padX, h: el.clientHeight - padY });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const limits = usage?.limits ?? [];
  const layout = layoutRings(padLimits(limits), box.w, box.h);
  const hidden = limits.length - layout.shown.length;
  const top = tightest(limits);

  let message: string | undefined;
  let label: string;
  if (!usage) {
    message = connected ? '…' : '';
    label = connected ? 'Usage limits: loading' : 'Usage limits: not connected';
  } else if (!usage.available) {
    message = 'No plan limits';
    label = 'Usage limits do not apply to this sign-in (API key or cloud provider)';
  } else if (!limits.length) {
    message = usage.error ? 'Tap to retry' : 'No limits reported';
    label = usage.error ?? 'Claude Code reported no usage limits';
  } else {
    label = `Usage limits. ${limits.map((l) => describeLimit(l)).join('. ')}`;
  }
  const hint = top
    ? `${describeLimit(top)} · tap for all limits`
    : (usage?.error ?? 'Tap for usage details');

  return (
    <button
      ref={ref}
      className={`deck-usage ${usage?.error ? 'stale' : ''} ${hidden > 0 ? 'has-more' : ''}`}
      style={{ gridArea: 'stick' }}
      aria-label={`${label}. Show usage details`}
      disabled={disabled}
      onPointerDown={() => onHint(hint)}
      onPointerUp={() => onHint(undefined)}
      onPointerLeave={() => onHint(undefined)}
      onClick={onOpen}
    >
      {message !== undefined || !layout.shown.length ? (
        <span className="usage-message">{message ?? percentText(top?.utilization ?? null)}</span>
      ) : (
        <span
          className="usage-grid"
          style={{ gridTemplateColumns: `repeat(${layout.cols}, auto)` }}
          aria-hidden
        >
          {layout.shown.map((limit) => (
            <Ring key={limit.id} limit={limit} size={layout.ring} withReset={layout.withReset} />
          ))}
        </span>
      )}
      {hidden > 0 && (
        <span className="usage-more" aria-hidden>
          +{hidden} more
        </span>
      )}
    </button>
  );
}
