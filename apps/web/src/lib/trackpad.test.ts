import { beforeEach, describe, expect, it } from 'vitest';
import { TrackpadGestures, type GestureSink } from './trackpad';

let calls: string[];
let gestures: TrackpadGestures;

const sink: GestureSink = {
  move: (dx, dy) => calls.push(`move ${dx} ${dy}`),
  scroll: (dx, dy) => calls.push(`scroll ${dx} ${dy}`),
  click: (b) => calls.push(`click ${b}`),
  buttonDown: (b) => calls.push(`down ${b}`),
  buttonUp: (b) => calls.push(`up ${b}`),
};

beforeEach(() => {
  calls = [];
  gestures = new TrackpadGestures(sink);
  gestures.configure({ sensitivity: 1, acceleration: 0, naturalScroll: true, scrollSpeed: 2 });
});

describe('TrackpadGestures', () => {
  it('turns a short stationary touch into a left click', () => {
    gestures.down(1, 100, 100, 0);
    gestures.up(1, 120);
    expect(calls).toEqual(['click left']);
  });

  it('moves the pointer and carries sub-pixel remainders', () => {
    gestures.configure({ sensitivity: 0.5, acceleration: 0, naturalScroll: true, scrollSpeed: 2 });
    gestures.down(1, 0, 0, 0);
    gestures.move(1, 3, 0, 16); // 1.5 → 1, remainder .5
    gestures.move(1, 6, 0, 32); // 1.5 + .5 → 2
    gestures.up(1, 400);
    expect(calls).toEqual(['move 1 0', 'move 2 0']);
  });

  it('accelerates fast swipes', () => {
    gestures.configure({ sensitivity: 1, acceleration: 1, naturalScroll: true, scrollSpeed: 2 });
    gestures.down(1, 0, 0, 0);
    gestures.move(1, 2, 0, 100); // slow: 0.02 px/ms → linear
    gestures.move(1, 52, 0, 110); // fast: 5 px/ms → boosted
    const [slow, fast] = calls.map((c) => Number(c.split(' ')[1]));
    expect(slow).toBe(2);
    expect(fast!).toBeGreaterThan(100);
  });

  it('maps two-finger taps to right click and three-finger taps to middle click', () => {
    gestures.down(1, 0, 0, 0);
    gestures.down(2, 50, 0, 10);
    gestures.up(1, 100);
    gestures.up(2, 110);
    gestures.down(1, 0, 0, 1000);
    gestures.down(2, 50, 0, 1005);
    gestures.down(3, 90, 0, 1010);
    gestures.up(1, 1100);
    gestures.up(2, 1100);
    gestures.up(3, 1100);
    expect(calls).toEqual(['click right', 'click middle']);
  });

  it('scrolls with two fingers, naturally by default', () => {
    gestures.down(1, 0, 100, 0);
    gestures.down(2, 50, 100, 0);
    gestures.move(1, 0, 80, 16); // fingers move up 20px
    gestures.move(2, 50, 80, 16);
    gestures.up(1, 300);
    gestures.up(2, 300);
    // each finger contributes half: 20 * 2 / 2 = 20 per finger → content scrolls down (+)
    expect(calls).toEqual(['scroll 0 20', 'scroll 0 20']);
  });

  it('tap then touch-and-move drags with the left button held', () => {
    gestures.down(1, 0, 0, 0);
    gestures.up(1, 80); // tap → click
    gestures.down(1, 0, 0, 200); // within double-tap window
    gestures.move(1, 20, 0, 216);
    gestures.up(1, 600);
    expect(calls).toEqual(['click left', 'down left', 'move 20 0', 'up left']);
  });

  it('does not click after a cancelled touch or a long press', () => {
    gestures.down(1, 0, 0, 0);
    gestures.up(1, 100, true);
    gestures.down(1, 0, 0, 1000);
    gestures.up(1, 1600);
    expect(calls).toEqual([]);
  });

  it('releases a held drag on reset', () => {
    gestures.down(1, 0, 0, 0);
    gestures.up(1, 50);
    gestures.down(1, 0, 0, 100);
    gestures.move(1, 30, 0, 120);
    gestures.reset();
    expect(calls.at(-1)).toBe('up left');
  });
});
