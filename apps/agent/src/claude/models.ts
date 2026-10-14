import type { ModelChoice } from '@voicecode/protocol';

/**
 * Model aliases every Claude Code understands (`--model`, `/model`, SDK `setModel`).
 * Used when the live list from the SDK is not available, e.g. for terminal sessions.
 * Which of them an account may use is decided by Claude Code, which reports an error
 * for the others.
 */
export const MODEL_ALIASES: ModelChoice[] = [
  { value: 'default', label: 'Default', description: 'What Claude Code uses on the PC' },
  { value: 'fable', label: 'Fable', description: 'Most capable (needs Fable access)' },
  { value: 'opus', label: 'Opus', description: 'Most capable for everyday work' },
  { value: 'sonnet', label: 'Sonnet', description: 'Fast and capable' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest' },
];

/** `null` and the `default` alias both mean "no override". */
export function isDefaultModel(model: string | null | undefined): boolean {
  return !model || model === 'default';
}
