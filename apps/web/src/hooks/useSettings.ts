import { useCallback, useState } from 'react';

export interface Settings {
  /** Claude tab style: a chat thread, or a macro pad (deck) under a shorter thread. */
  claudeLayout: 'chat' | 'deck';
  /** Deck layout: show the conversation above the pad, or give the pad the whole screen. */
  deckHistory: boolean;
  /** Base pointer speed multiplier (phone CSS px → desktop px). */
  sensitivity: number;
  /** How strongly fast swipes are amplified. 0 = linear. */
  acceleration: number;
  /** Content follows the fingers, like a laptop trackpad. */
  naturalScroll: boolean;
  scrollSpeed: number;
  /** Send the prompt automatically when dictation ends. */
  autoSendVoice: boolean;
  /** Read Claude's reply aloud when a turn finishes. */
  speakReplies: boolean;
  /** Show a system notification for approvals while the app is in the background. */
  notifyApprovals: boolean;
  /** BCP 47 language tag for speech recognition. */
  voiceLang: string;
  /**
   * Where speech is turned into text: this browser's speech service, or Claude Code's
   * own dictation on the PC (the phone streams audio into a virtual microphone there).
   */
  dictation: 'browser' | 'claude-code';
  /** Model for the sessions this phone starts ('' = the PC's default). */
  model: string;
}

const KEY = 'voicecode.settings.v1';

const defaults: Settings = {
  claudeLayout: 'chat',
  deckHistory: true,
  sensitivity: 1.6,
  acceleration: 0.8,
  naturalScroll: true,
  scrollSpeed: 3,
  autoSendVoice: false,
  notifyApprovals: false,
  speakReplies: false,
  voiceLang: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
  dictation: 'browser',
  model: '',
};

function load(): Settings {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return defaults;
  }
}

/** Per-device preferences, kept in localStorage (they are not secrets). */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode); settings still apply for this visit.
      }
      return next;
    });
  }, []);
  return [settings, update] as const;
}
