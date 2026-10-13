import { LIMITS, type ClientMessage, type MouseButton } from '@voicecode/protocol';
import type { GestureSink } from './trackpad';

const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/**
 * Accumulates movement and scroll deltas and sends them once per animation frame, so
 * the message rate follows the display refresh rather than the (often much higher)
 * touch sampling rate. Button events flush pending movement first to keep ordering.
 */
export class InputBatcher implements GestureSink {
  private mx = 0;
  private my = 0;
  private sx = 0;
  private sy = 0;
  private frame = 0;

  constructor(
    private readonly send: (message: ClientMessage) => void,
    private readonly onPress: () => void = () => undefined,
  ) {}

  move(dx: number, dy: number): void {
    this.mx += dx;
    this.my += dy;
    this.schedule();
  }

  scroll(dx: number, dy: number): void {
    this.sx += dx;
    this.sy += dy;
    this.schedule();
  }

  click(button: MouseButton): void {
    this.flush();
    this.onPress();
    this.send({ type: 'mouse.click', button });
  }

  buttonDown(button: MouseButton): void {
    this.flush();
    this.onPress();
    this.send({ type: 'mouse.button.down', button });
  }

  buttonUp(button: MouseButton): void {
    this.flush();
    this.send({ type: 'mouse.button.up', button });
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.dispose();
    if (this.mx || this.my) {
      this.send({
        type: 'mouse.move',
        dx: clamp(this.mx, LIMITS.maxMouseDelta),
        dy: clamp(this.my, LIMITS.maxMouseDelta),
      });
    }
    if (this.sx || this.sy) {
      this.send({
        type: 'mouse.scroll',
        dx: clamp(this.sx, LIMITS.maxScrollDelta),
        dy: clamp(this.sy, LIMITS.maxScrollDelta),
      });
    }
    this.mx = this.my = this.sx = this.sy = 0;
  }
}
