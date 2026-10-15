import type { StorageCategory } from '@voicecode/protocol';

export const CATEGORY_LABELS: Record<StorageCategory, string> = {
  temp: 'Unfinished downloads and temp files',
  attachments: 'Images sent from the phone',
  downloads: 'Old Claude Code versions',
  runtime: 'Old agent versions',
  logs: 'Old log',
};

/** Choices for the automatic cleanup limit, in MB. */
export const LIMIT_CHOICES_MB = [100, 250, 500, 1000, 2000] as const;

/** 1 234 567 → "1.2 MB" (binary units, as file managers on Windows show them). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatLimit(mb: number): string {
  return mb >= 1000 && mb % 1000 === 0 ? `${mb / 1000} GB` : `${mb} MB`;
}
