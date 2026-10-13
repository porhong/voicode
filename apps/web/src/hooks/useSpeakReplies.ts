import { useEffect, useRef } from 'react';
import { speakableText } from '../components/Markdown';
import type { EventItem } from '../lib/store';

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function stopSpeaking(): void {
  if (speechSynthesisSupported()) window.speechSynthesis.cancel();
}

/**
 * Reads Claude's reply aloud when a turn finishes: the assistant text written after
 * the last prompt. Uses the device's own speech synthesis; nothing leaves the phone.
 */
export function useSpeakReplies(
  sessionId: string | undefined,
  events: EventItem[],
  enabled: boolean,
  lang: string,
): void {
  const position = useRef<{ sessionId?: string; seq: number } | null>(null);

  useEffect(() => {
    const last = events.at(-1);
    // When the view (re)attaches to a session, never read out its existing history.
    if (!position.current || position.current.sessionId !== sessionId) {
      position.current = { sessionId, seq: last?.seq ?? 0 };
      return;
    }
    const spokenUpTo = position.current;
    if (!last || last.seq <= spokenUpTo.seq) return;
    spokenUpTo.seq = last.seq;
    if (!enabled || !speechSynthesisSupported() || last.event.kind !== 'result') return;
    // A reconnect snapshot can deliver an old, already-finished turn; only speak fresh ones.
    if (Date.now() - last.at > 120_000) return;

    const turn: string[] = [];
    for (let i = events.length - 2; i >= 0; i--) {
      const e = events[i]!.event;
      if (e.kind === 'user_prompt') break;
      if (e.kind === 'assistant_text') turn.unshift(e.text);
    }
    const text = speakableText(turn.join('\n\n'));
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 4000));
    utterance.lang = lang;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [sessionId, events, enabled, lang]);

  useEffect(() => stopSpeaking, []);
}
