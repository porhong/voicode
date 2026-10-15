import { useEffect, useRef } from 'react';
import type { SessionState } from '@voicecode/protocol';
import { playAlertSound, type AlertSoundType } from '../lib/sound';
import type { EventItem, Toast } from '../lib/store';

export interface UseAlertSoundsOptions {
  /** Whether alert sound effects are turned on in user settings. */
  enabled: boolean;
  /** Active phone session id currently on screen. */
  activeSessionId?: string;
  /** Events for the active phone session. */
  activeEvents: EventItem[];
  /** Lifecycle state of the active phone session. */
  activeState?: SessionState;
  /** Active PC session id if a PC terminal session is on screen. */
  pcSessionId?: string;
  /** Events for the active PC session. */
  pcEvents: EventItem[];
  /** Background task completion notices. */
  toasts: Toast[];
  /** Agent-level error notice. */
  error?: { message: string; at: number };
  /** Dictation or virtual microphone error message. */
  dictationError?: string;
}

export interface StreamPosition {
  sessionId?: string;
  seq: number;
}

/**
 * Determines whether a new event in an event stream warrants an alert sound.
 * Ignores old/stale events, initial history on session switch, and previously seen sequences.
 */
export function evaluateStreamEvent(
  sessionId: string | undefined,
  events: EventItem[],
  position: StreamPosition | null,
  enabled: boolean,
  now = Date.now(),
): { nextPosition: StreamPosition; sound: AlertSoundType | null } {
  const last = events.at(-1);

  // When switching sessions or mounting, sync position without alerting on past turns.
  if (!position || position.sessionId !== sessionId) {
    return {
      nextPosition: { sessionId, seq: last?.seq ?? 0 },
      sound: null,
    };
  }

  if (!last || last.seq <= position.seq) {
    return { nextPosition: position, sound: null };
  }

  const nextPosition = { sessionId, seq: last.seq };

  // Stale event (e.g. from a reconnect snapshot)
  if (!enabled || now - last.at > 60_000) {
    return { nextPosition, sound: null };
  }

  if (last.event.kind === 'result') {
    return { nextPosition, sound: last.event.isError ? 'error' : 'done' };
  }
  if (last.event.kind === 'error') {
    return { nextPosition, sound: 'error' };
  }

  return { nextPosition, sound: null };
}

/**
 * Determines whether a session lifecycle state transition warrants an error alert.
 */
export function evaluateStateTransition(
  sessionId: string | undefined,
  currentState: SessionState | undefined,
  prevState: { sessionId?: string; state?: SessionState },
  enabled: boolean,
): AlertSoundType | null {
  if (!sessionId || !enabled) return null;
  if (
    prevState.sessionId === sessionId &&
    prevState.state !== 'error' &&
    currentState === 'error'
  ) {
    return 'error';
  }
  return null;
}

/**
 * Determines whether a background toast arrival warrants an alert sound.
 */
export function evaluateToastAlert(
  toasts: Toast[],
  lastToastId: number,
  enabled: boolean,
): { sound: AlertSoundType | null; fallbackVibrate: boolean } {
  const newest = toasts[0]?.id ?? 0;
  if (newest <= lastToastId) {
    return { sound: null, fallbackVibrate: false };
  }
  const toast = toasts[0];
  if (enabled) {
    return { sound: toast?.isError ? 'error' : 'done', fallbackVibrate: false };
  }
  return { sound: null, fallbackVibrate: true };
}

/**
 * Triggers sound alerts (and subtle haptics) when a task finishes (job done)
 * or when an error occurs across active and background sessions.
 */
export function useAlertSounds({
  enabled,
  activeSessionId,
  activeEvents,
  activeState,
  pcSessionId,
  pcEvents,
  toasts,
  error,
  dictationError,
}: UseAlertSoundsOptions): void {
  // Active phone session events
  const activePosition = useRef<StreamPosition | null>(null);
  useEffect(() => {
    const { nextPosition, sound } = evaluateStreamEvent(
      activeSessionId,
      activeEvents,
      activePosition.current,
      enabled,
    );
    activePosition.current = nextPosition;
    if (sound) playAlertSound(sound);
  }, [activeSessionId, activeEvents, enabled]);

  // Active phone session error transition
  const lastActiveState = useRef<{ sessionId?: string; state?: SessionState }>({});
  useEffect(() => {
    const sound = evaluateStateTransition(
      activeSessionId,
      activeState,
      lastActiveState.current,
      enabled,
    );
    lastActiveState.current = { sessionId: activeSessionId, state: activeState };
    if (sound) playAlertSound(sound);
  }, [activeSessionId, activeState, enabled]);

  // Active PC session events
  const pcPosition = useRef<StreamPosition | null>(null);
  useEffect(() => {
    if (!pcSessionId) {
      pcPosition.current = null;
      return;
    }
    const { nextPosition, sound } = evaluateStreamEvent(
      pcSessionId,
      pcEvents,
      pcPosition.current,
      enabled,
    );
    pcPosition.current = nextPosition;
    if (sound) playAlertSound(sound);
  }, [pcSessionId, pcEvents, enabled]);

  // Background task completion or failure toasts
  const lastToastId = useRef(toasts[0]?.id ?? 0);
  useEffect(() => {
    const { sound, fallbackVibrate } = evaluateToastAlert(toasts, lastToastId.current, enabled);
    const newest = toasts[0]?.id ?? 0;
    lastToastId.current = Math.max(lastToastId.current, newest);
    if (sound) {
      playAlertSound(sound);
    } else if (fallbackVibrate) {
      navigator.vibrate?.(20);
    }
  }, [toasts, enabled]);

  // Agent/server error banner
  const lastErrorAt = useRef(error?.at ?? 0);
  useEffect(() => {
    if (!error) return;
    if (error.at > lastErrorAt.current) {
      lastErrorAt.current = error.at;
      if (enabled) playAlertSound('error');
    }
  }, [error, enabled]);

  // Dictation/voice stream error
  const lastDictationError = useRef(dictationError);
  useEffect(() => {
    if (dictationError && dictationError !== lastDictationError.current) {
      if (enabled) playAlertSound('error');
    }
    lastDictationError.current = dictationError;
  }, [dictationError, enabled]);
}
