import type { MouseButton } from '@voicecode/protocol';

/**
 * A platform mouse backend. Implementations must be safe to call at high frequency;
 * the input router already coalesces movement, so each call maps to roughly one OS
 * input event.
 */
export interface MouseDriver {
  readonly name: string;
  start(): Promise<DriverInfo>;
  /** Relative pointer movement in physical pixels. */
  move(dx: number, dy: number): void;
  button(button: MouseButton, down: boolean): void;
  /**
   * Scroll in wheel units, where 120 is one notch. Positive `dy` scrolls the content
   * down (like DOM `WheelEvent.deltaY`); positive `dx` scrolls right.
   */
  scroll(dx: number, dy: number): void;
  position(): Promise<{ x: number; y: number }>;
  stop(): Promise<void>;
  /** Called when the backend dies unexpectedly. */
  onExit(listener: (error: Error) => void): void;
}

export interface DriverInfo {
  /** Free-form details reported by the backend, e.g. Windows session id / integrity level. */
  details: Record<string, string>;
}

export class MouseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MouseUnavailableError';
  }
}
