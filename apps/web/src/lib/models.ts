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
