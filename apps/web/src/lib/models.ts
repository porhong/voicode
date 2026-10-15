import type { EffortLevel } from '@voicecode/protocol';

/** Choices for "Model for new sessions" ('' leaves it to the PC). */
export const MODEL_PRESETS: Array<[value: string, label: string]> = [
  ['', 'PC default'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];

const FAMILY = /(fable|mythos|opus|sonnet|haiku)/i;

/**
 * A short name for a model id, alias or Claude Code label, for the header chip:
 * `claude-opus-5-5` → "Opus 5.5", `sonnet` → "Sonnet", `Sonnet 5.5 (default)` → "Sonnet 5.5".
 */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model
    .replace(/\[[^\]]*\]$/, '')
    .replace(/\s*\(default\)\s*$/i, '')
    .trim();
  if (/^default$/i.test(m)) return 'Default';
  const family = FAMILY.exec(m)?.[1];
  if (!family) return m.length > 16 ? `${m.slice(0, 15)}…` : m;
  const name = family[0]!.toUpperCase() + family.slice(1).toLowerCase();
  const version = new RegExp(`${family}[- ]?(\\d+)(?:[-.](\\d{1,2}))?(?!\\d)`, 'i').exec(m);
  if (!version) return name;
  return version[2] ? `${name} ${version[1]}.${version[2]}` : `${name} ${version[1]}`;
}

/** Effort levels by name, with what each means for the replies. */
export const EFFORT_TEXT: Record<EffortLevel, { name: string; hint: string }> = {
  low: { name: 'Low', hint: 'Quick answers with light reasoning. Uses the least of your limits.' },
  medium: { name: 'Medium', hint: 'Balances speed and depth.' },
  high: { name: 'High', hint: 'Thinks problems through. Suits most coding work.' },
  xhigh: { name: 'Extra high', hint: 'More depth for hard problems. Slower replies.' },
  max: {
    name: 'Max',
    hint: 'The deepest reasoning, for this session only. Slowest, and uses the most of your limits.',
  },
};

/** The effort as it fits on the model chip. */
export const EFFORT_SHORT: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};
