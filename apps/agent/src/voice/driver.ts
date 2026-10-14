/**
 * A virtual-microphone backend: plays the phone's PCM audio into an output that the
 * PC sees as a microphone, so Claude Code's own dictation (`/voice`) can record it.
 * Audio is always the wire format from `AUDIO` (16 kHz, mono, s16le); drivers never
 * resample.
 */
export interface VirtualMicDriver {
  readonly name: string;
  start(): Promise<VirtualMicInfo>;
  /** A device took the lease and will stream now (e.g. make the sink the default source). */
  activate(): Promise<void>;
  /** The lease ended: undo whatever `activate` changed. */
  deactivate(): Promise<void>;
  /** Queues PCM for playback. Must not throw on a dead backend; `onExit` reports that. */
  write(pcm: Buffer): void;
  stop(): Promise<void>;
  /** Called when the backend dies unexpectedly. */
  onExit(listener: (error: Error) => void): void;
}

export interface VirtualMicInfo {
  /** The playback device or sink the audio goes to, for the status line. */
  device: string;
  details?: Record<string, string>;
}

export class VirtualMicUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VirtualMicUnavailableError';
  }
}
