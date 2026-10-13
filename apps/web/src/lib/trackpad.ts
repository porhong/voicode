import type { MouseButton } from '@voicecode/protocol';

export interface GestureSink {
  move(dx: number, dy: number): void;
  scroll(dx: number, dy: number): void;
  click(button: MouseButton): void;
  buttonDown(button: MouseButton): void;
  buttonUp(button: MouseButton): void;
}

export interface GestureSettings {
  sensitivity: number;
  acceleration: number;
  naturalScroll: boolean;
  scrollSpeed: number;
}

/** Max finger travel (CSS px) for a touch to still count as a tap. */
const TAP_SLOP = 8;
/** Max tap duration. */
const TAP_MS = 250;
/** Tap, then touch again within this window and move = drag (button held). */
const DOUBLE_TAP_MS = 300;

interface Pointer {
  x: number;
  y: number;
  startX: number;
  startY: number;
  t: number;
}

/**
 * Laptop-style trackpad gestures from raw pointer events:
 *
 *   one finger move        → pointer move, with speed-based acceleration
 *   one finger tap         → left click
 *   two finger tap         → right click;   three finger tap → middle click
 *   two finger move        → scroll (natural or traditional)
 *   tap, then touch & move → drag with the left button held
 *
 * Output deltas are integers; fractional remainders are carried forward so slow,
 * precise movements are not lost to rounding.
 */
export class TrackpadGestures {
  private readonly pointers = new Map<number, Pointer>();
  private maxPointers = 0;
  private gestureStart = 0;
  private moved = false;
  private lastTapEnd = -Infinity;
  private dragArmed = false;
  private dragging = false;
  private remainder = { x: 0, y: 0 };
  private scrollRemainder = { x: 0, y: 0 };

  private settings: GestureSettings = {
    sensitivity: 1.6,
    acceleration: 0.8,
    naturalScroll: true,
    scrollSpeed: 3,
  };

  constructor(private readonly sink: GestureSink) {}

  configure(settings: GestureSettings): void {
    this.settings = settings;
  }

  down(id: number, x: number, y: number, t: number): void {
    if (this.pointers.size === 0) {
      this.maxPointers = 0;
      this.moved = false;
      this.gestureStart = t;
      this.dragArmed = t - this.lastTapEnd < DOUBLE_TAP_MS;
      this.remainder = { x: 0, y: 0 };
      this.scrollRemainder = { x: 0, y: 0 };
    }
    this.pointers.set(id, { x, y, startX: x, startY: y, t });
    this.maxPointers = Math.max(this.maxPointers, this.pointers.size);
  }

  move(id: number, x: number, y: number, t: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    const dx = x - p.x;
    const dy = y - p.y;
    const dt = Math.max(1, t - p.t);
    p.x = x;
    p.y = y;
    p.t = t;
    if (Math.hypot(x - p.startX, y - p.startY) > TAP_SLOP) this.moved = true;

    const s = this.settings;
    if (this.pointers.size === 1 && this.maxPointers === 1) {
      if (this.dragArmed && this.moved && !this.dragging) {
        this.dragging = true;
        this.sink.buttonDown('left');
      }
      const speed = Math.hypot(dx, dy) / dt; // CSS px per ms
      const gain = s.sensitivity * (1 + s.acceleration * Math.min(Math.max(speed - 0.15, 0), 3));
      this.emitMove(dx * gain, dy * gain);
    } else if (this.pointers.size === 2) {
      // Each finger reports separately; averaging means each contributes half.
      const direction = s.naturalScroll ? -1 : 1;
      const k = (s.scrollSpeed * direction) / 2;
      this.emitScroll(dx * k, dy * k);
    }
  }

  up(id: number, t: number, cancelled = false): void {
    if (!this.pointers.delete(id) || this.pointers.size > 0) return;

    if (this.dragging) {
      this.dragging = false;
      this.dragArmed = false;
      this.sink.buttonUp('left');
      return;
    }
    if (!cancelled && !this.moved && t - this.gestureStart < TAP_MS) {
      if (this.maxPointers === 1) {
        this.sink.click('left');
        this.lastTapEnd = t;
      } else if (this.maxPointers === 2) {
        this.sink.click('right');
      } else if (this.maxPointers >= 3) {
        this.sink.click('middle');
      }
    }
    this.dragArmed = false;
  }

  /** Releases a held drag button, e.g. when the view is hidden mid-gesture. */
  reset(): void {
    if (this.dragging) this.sink.buttonUp('left');
    this.pointers.clear();
    this.dragging = false;
    this.dragArmed = false;
  }

  private emitMove(fx: number, fy: number): void {
    const [ix, iy] = take(this.remainder, fx, fy);
    if (ix || iy) this.sink.move(ix, iy);
  }

  private emitScroll(fx: number, fy: number): void {
    const [ix, iy] = take(this.scrollRemainder, fx, fy);
    if (ix || iy) this.sink.scroll(ix, iy);
  }
}

/** Adds a fractional delta to an accumulator and takes out the whole-number part. */
function take(acc: { x: number; y: number }, fx: number, fy: number): [number, number] {
  acc.x += fx;
  acc.y += fy;
  const ix = Math.trunc(acc.x);
  const iy = Math.trunc(acc.y);
  acc.x -= ix;
  acc.y -= iy;
  return [ix, iy];
}
