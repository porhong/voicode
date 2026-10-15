import { useCallback, useState } from 'react';
import { LIMITS } from '@voicecode/protocol';
import { DECK_ICON_NAMES, type DeckIconName } from '../components/DeckIcons';

/** One programmable control: a prompt sent to Claude (or put in the box to review). */
export interface Macro {
  label: string;
  icon: DeckIconName;
  prompt: string;
  /** Put the prompt in the box for editing instead of sending it straight away. */
  review: boolean;
}

export type Direction = 'up' | 'right' | 'down' | 'left';
export const DIRECTIONS: Direction[] = ['up', 'right', 'down', 'left'];

/** What sits below the wheel: the four-way joystick, or the plan's usage rings. */
export type DeckPad = 'stick' | 'usage';

export interface DeckConfig {
  /** The six translucent keys, top row first. */
  keys: Macro[];
  /** The joystick's four pushes (kept while the usage rings are shown). */
  stick: Record<Direction, Macro>;
  pad: DeckPad;
}

export const KEY_COUNT = 6;

const m = (label: string, icon: DeckIconName, prompt: string, review = false): Macro => ({
  label,
  icon,
  prompt,
  review,
});

/**
 * Ready-made prompts to pick from when customising a control. They are ordinary
 * prompts: Claude still asks before running anything.
 */
export const PRESET_MACROS: Macro[] = [
  m('Overview', 'compass', 'Give me a quick overview of this project.'),
  m('Run tests', 'flask', 'Run the tests and fix any failures.'),
  m('Fix bug', 'bug', 'Find and fix the bug I describe: ', true),
  m('Review', 'eye', 'Review the uncommitted changes for bugs and risky edits.'),
  m('Diff', 'diff', 'What changed since the last commit? Summarise it briefly.'),
  m('Commit', 'commit', 'Write a good commit message for the current changes and commit them.'),
  m('Lint', 'broom', 'Run the linter and type checker and fix what they report.'),
  m('Explain', 'question', 'Explain what you just did and why, in a few sentences.'),
  m('Plan', 'list', 'Before changing anything, write a short step-by-step plan for: ', true),
  m('Continue', 'play', 'Continue.'),
  m('Simplify', 'wand', 'Simplify the code you just wrote without changing its behaviour.'),
  m('Docs', 'doc', 'Update the README and comments to match the latest changes.'),
  m('Build', 'hammer', 'Build the project and fix any errors.'),
  m('Ship', 'rocket', 'Check everything is green, then push the current branch.'),
  m('Undo', 'undo', 'Revert your last change.'),
  m('Shorter', 'compress', 'Say that again, much shorter.'),
];

const preset = (label: string) => PRESET_MACROS.find((p) => p.label === label)!;

/** Whole-deck layouts, like swapping keycap sets. */
export const DECK_PACKS: Array<{ name: string; description: string; config: DeckConfig }> = [
  {
    name: 'Build',
    description: 'Tests, fixes, commits',
    config: {
      keys: ['Overview', 'Run tests', 'Fix bug', 'Review', 'Diff', 'Commit'].map(preset),
      stick: {
        up: preset('Continue'),
        right: preset('Explain'),
        down: preset('Shorter'),
        left: preset('Undo'),
      },
      pad: 'stick',
    },
  },
  {
    name: 'Review',
    description: 'Read and check code',
    config: {
      keys: ['Review', 'Diff', 'Explain', 'Lint', 'Simplify', 'Docs'].map(preset),
      stick: {
        up: preset('Continue'),
        right: preset('Plan'),
        down: preset('Shorter'),
        left: preset('Undo'),
      },
      pad: 'stick',
    },
  },
  {
    name: 'Ship',
    description: 'Build, verify, push',
    config: {
      keys: ['Build', 'Run tests', 'Lint', 'Diff', 'Commit', 'Ship'].map(preset),
      stick: {
        up: preset('Continue'),
        right: preset('Review'),
        down: preset('Shorter'),
        left: preset('Undo'),
      },
      pad: 'stick',
    },
  },
];

export const DEFAULT_DECK: DeckConfig = DECK_PACKS[0]!.config;

const KEY = 'voicecode.deck.v1';

function cleanMacro(value: unknown, fallback: Macro): Macro {
  if (!value || typeof value !== 'object') return fallback;
  const v = value as Partial<Macro>;
  return {
    label: typeof v.label === 'string' ? v.label.slice(0, 24) : fallback.label,
    icon: DECK_ICON_NAMES.includes(v.icon as DeckIconName) ? v.icon! : fallback.icon,
    prompt:
      typeof v.prompt === 'string' ? v.prompt.slice(0, LIMITS.maxPromptLength) : fallback.prompt,
    review: typeof v.review === 'boolean' ? v.review : fallback.review,
  };
}

/** Stored layouts are re-validated: an old or hand-edited one can't break the page. */
export function parseDeck(raw: unknown): DeckConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeckConfig>;
  const keys = Array.isArray(v.keys) ? v.keys : [];
  const stick = (v.stick && typeof v.stick === 'object' ? v.stick : {}) as Partial<
    Record<Direction, unknown>
  >;
  return {
    keys: DEFAULT_DECK.keys.map((fallback, i) => cleanMacro(keys[i], fallback)),
    stick: Object.fromEntries(
      DIRECTIONS.map((d) => [d, cleanMacro(stick[d], DEFAULT_DECK.stick[d])]),
    ) as Record<Direction, Macro>,
    pad: v.pad === 'usage' ? 'usage' : 'stick',
  };
}

function load(): DeckConfig {
  try {
    return parseDeck(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_DECK;
  }
}

/** The deck layout for this device, kept in localStorage next to the settings. */
export function useDeck() {
  const [deck, setDeck] = useState<DeckConfig>(load);
  const save = useCallback((next: DeckConfig) => {
    setDeck(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable (private mode); the layout still applies for this visit.
    }
  }, []);
  return [deck, save] as const;
}
