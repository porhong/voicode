/**
 * Synthesised audio alerts via Web Audio API.
 * Uses clean sine/triangle oscillator synthesis so no external audio assets or network requests are needed.
 */

export type AlertSoundType = 'done' | 'error';

/** Whether the environment supports the Web Audio API. */
export function audioSupported(): boolean {
  const scope = typeof window !== 'undefined' ? window : globalThis;
  return (
    scope !== undefined &&
    ('AudioContext' in scope ||
      'webkitAudioContext' in (scope as unknown as Record<string, unknown>))
  );
}

let sharedContext: AudioContext | null = null;

/** Returns the shared AudioContext instance, lazily instantiated. */
export function getAudioContext(): AudioContext | null {
  if (!audioSupported()) return null;
  const scope = typeof window !== 'undefined' ? window : globalThis;
  const Ctx =
    (scope as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
    (scope as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;

  if (!sharedContext || sharedContext.state === 'closed') {
    try {
      sharedContext = new Ctx();
    } catch {
      return null;
    }
  }
  return sharedContext;
}

/** Test helper to reset or inject an AudioContext. */
export function setAudioContextForTest(ctx: AudioContext | null): void {
  sharedContext = ctx;
}

/** Pre-warms or resumes the AudioContext on user interaction (pointerdown / keydown). */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

// Auto-register gesture unlock on browser window if available
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const onGesture = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
  };
  window.addEventListener('pointerdown', onGesture, { once: true, passive: true });
  window.addEventListener('keydown', onGesture, { once: true, passive: true });
}

/**
 * Ascending pleasant 2-tone chime for task completion:
 * Note 1: D5 (587.33 Hz) warm body
 * Note 2: A5 (880.00 Hz) ringing harmonic fifth
 */
function playDoneChime(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.2, now);
  master.connect(ctx.destination);

  // Note 1: D5
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(587.33, now);
  gain1.gain.setValueAtTime(0.0001, now);
  gain1.gain.exponentialRampToValueAtTime(1, now + 0.015);
  gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc1.connect(gain1);
  gain1.connect(master);
  osc1.start(now);
  osc1.stop(now + 0.36);

  // Note 2: A5 (starts 100ms later)
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(880.0, now + 0.1);
  gain2.gain.setValueAtTime(0.0001, now);
  gain2.gain.setValueAtTime(0.0001, now + 0.1);
  gain2.gain.exponentialRampToValueAtTime(0.9, now + 0.115);
  gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  osc2.connect(gain2);
  gain2.connect(master);
  osc2.start(now + 0.1);
  osc2.stop(now + 0.56);
}

/**
 * Distinct 2-tone descending alert for errors:
 * Tone 1: A4 (440 Hz) triangle
 * Tone 2: Eb4 (311.13 Hz) diminished tension tone
 */
function playErrorTone(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.22, now);
  master.connect(ctx.destination);

  // Tone 1: A4
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'triangle';
  osc1.frequency.setValueAtTime(440.0, now);
  gain1.gain.setValueAtTime(0.0001, now);
  gain1.gain.exponentialRampToValueAtTime(0.9, now + 0.015);
  gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc1.connect(gain1);
  gain1.connect(master);
  osc1.start(now);
  osc1.stop(now + 0.15);

  // Tone 2: Eb4
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(311.13, now + 0.12);
  gain2.gain.setValueAtTime(0.0001, now);
  gain2.gain.setValueAtTime(0.001, now + 0.12);
  gain2.gain.exponentialRampToValueAtTime(1, now + 0.135);
  gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  osc2.connect(gain2);
  gain2.connect(master);
  osc2.start(now + 0.12);
  osc2.stop(now + 0.43);
}

let lastPlayed = { type: '', at: 0 };

/**
 * Plays the requested alert sound ('done' | 'error') and triggers matching haptic feedback.
 * Automatically throttles identical sounds within 350ms unless force=true.
 */
export function playAlertSound(type: AlertSoundType, force = false): void {
  const now = Date.now();
  if (!force && lastPlayed.type === type && now - lastPlayed.at < 350) {
    return;
  }
  lastPlayed = { type, at: now };

  // Subtle haptic vibration pattern
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      if (type === 'done') {
        navigator.vibrate(35);
      } else {
        navigator.vibrate([60, 40, 80]);
      }
    } catch {
      // Ignore vibration errors
    }
  }

  const ctx = getAudioContext();
  if (!ctx) return;

  const play = () => {
    try {
      if (type === 'done') {
        playDoneChime(ctx);
      } else {
        playErrorTone(ctx);
      }
    } catch {
      // Audio execution failure (e.g. device disconnected)
    }
  };

  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(play)
      .catch(() => undefined);
  } else {
    play();
  }
}
