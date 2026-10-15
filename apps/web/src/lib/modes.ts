import type { PermissionModeName } from '@voicecode/protocol';

/** Permission modes by name, what each does, and how risky it is. */
export const MODE_TEXT: Record<
  PermissionModeName,
  { name: string; short: string; hint: string; risk: 'safe' | 'caution' | 'danger' }
> = {
  default: {
    name: 'Manual',
    short: 'Manual',
    hint: 'Asks you before every edit and command.',
    risk: 'safe',
  },
  acceptEdits: {
    name: 'Accept edits',
    short: 'Edits',
    hint: 'File edits go through without asking; commands still ask.',
    risk: 'safe',
  },
  plan: {
    name: 'Plan',
    short: 'Plan',
    hint: 'Claude only reads and plans, and asks before it starts changing things.',
    risk: 'safe',
  },
  auto: {
    name: 'Auto',
    short: 'Auto',
    hint: 'A classifier approves routine actions; risky ones still ask.',
    risk: 'caution',
  },
  dontAsk: {
    name: 'Don’t ask',
    short: 'No ask',
    hint: 'Never asks: anything not already allowed in settings is refused.',
    risk: 'caution',
  },
  bypassPermissions: {
    name: 'Bypass permissions',
    short: 'Bypass',
    hint: 'Runs every edit and command without asking. Nothing comes to the phone.',
    risk: 'danger',
  },
};
