import { describe, expect, it } from 'vitest';
import { readMenu, readPermissionMode, readVoiceScreen } from './voice-screen.js';

describe('readVoiceScreen', () => {
  it('sees recording, the enabled hint and errors', () => {
    expect(readVoiceScreen(['> ', '  ● REC · tap to send'])).toMatchObject({
      recording: true,
      enabled: true,
    });
    expect(readVoiceScreen(['> refactor the auth', '  listening…'])).toMatchObject({
      recording: true,
    });
    expect(readVoiceScreen(['> ', '  hold space to speak'])).toMatchObject({
      recording: false,
      enabled: true,
      error: undefined,
    });
    expect(readVoiceScreen(['Voice mode enabled (tap). Tap space to record.'])).toMatchObject({
      enabled: true,
    });
    expect(readVoiceScreen(['> ', 'Voice mode requires a Claude.ai account. Run /login.'])).toEqual(
      {
        recording: false,
        enabled: false,
        error: 'Voice mode requires a Claude.ai account. Run /login.',
        dialog: undefined,
      },
    );
    expect(readVoiceScreen(['  No audio detected from microphone'])).toMatchObject({
      error: 'No audio detected from microphone',
    });
    expect(readVoiceScreen(['Unknown command: /voice'])).toMatchObject({
      error: 'Unknown command: /voice',
    });
  });

  it('notices questions only the terminal can answer', () => {
    expect(
      readVoiceScreen([
        'Quick safety check: Is this a project you created or one you trust?',
        '❯ No, exit',
        '  Yes, I trust this folder',
        'Enter to confirm · Esc to cancel',
      ]).dialog,
    ).toMatch(/safety check/);
    expect(
      readVoiceScreen(['Do you trust the files in this folder?', '❯ Yes, proceed']),
    ).toMatchObject({ dialog: 'Do you trust the files in this folder?' });
    expect(readVoiceScreen(['> hello']).dialog).toBeUndefined();
  });
});

describe('readPermissionMode', () => {
  it('reads each mode from the footer Claude Code prints', () => {
    const footer = (text: string) => ['❯ ', '────', `  ${text} · ← for agents`];
    expect(readPermissionMode(footer('⏸ manual mode on · ? for shortcuts'))).toBe('default');
    expect(readPermissionMode(footer('⏵⏵ accept edits on (shift+tab to cycle)'))).toBe(
      'acceptEdits',
    );
    expect(readPermissionMode(footer('⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(readPermissionMode(footer('⏵⏵ auto mode on (shift+tab to cycle)'))).toBe('auto');
    expect(readPermissionMode(footer('⏵⏵ bypass permissions on (shift+tab to cycle)'))).toBe(
      'bypassPermissions',
    );
  });

  it('only reads the footer, not earlier output that mentions a mode', () => {
    expect(
      readPermissionMode(['Turn plan mode on with shift+tab', '', 'x', 'y', 'z']),
    ).toBeUndefined();
  });
});

/** Screens of Claude Code 2.1.299, captured from a real session in a pty. */
const TRUST = [
  '',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' C:\\Users\\me\\AppData\\Local\\Temp\\vc-menus',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a',
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  ' this folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
];
const PERMISSION = [
  ' ▐▛███▛█   Claude Code v2.1.299',
  '❯ Run this PowerShell command exactly: Set-Content -Path menu.txt -Value hi',
  '',
  '  ⎿  $ Set-Content -Path menu.txt -Value hi',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  ' PowerShell command',
  ' Write "hi" to menu.txt in the working directory',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Set-Content -Path menu.txt -Value hi',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to C:\\work from this',
  '      project',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

describe('readMenu', () => {
  it('reads the folder trust check, with its question picked out of the paragraph', () => {
    expect(readMenu(TRUST)).toMatchObject({
      question: 'Quick safety check: Is this a project you created or one you trust?',
      options: ['No, exit', 'Yes, I trust this folder'],
      selected: 0,
    });
    const moved = TRUST.map((l) =>
      l === ' ❯ No, exit'
        ? '   No, exit'
        : l === '   Yes, I trust this folder'
          ? ' ❯ Yes, I trust this folder'
          : l,
    );
    expect(readMenu(moved)?.selected).toBe(1);
  });

  it('reads a permission prompt with what it is about, joining wrapped options', () => {
    expect(readMenu(PERMISSION)).toEqual({
      question: 'Do you want to proceed?',
      detail: [
        'PowerShell command',
        'Write "hi" to menu.txt in the working directory',
        'Set-Content -Path menu.txt -Value hi',
      ],
      options: ['Yes', 'Yes, and always allow access to C:\\work from this project', 'No'],
      selected: 0,
    });
  });

  it('never takes the input prompt or a list in a reply for a menu', () => {
    expect(
      readMenu([
        '❯ fix the build',
        '',
        '────────────────────────────────────────────────────────────────────────────────────────────────────',
        '  ? for shortcuts',
      ]),
    ).toBeUndefined();
    expect(
      readMenu(['● Steps:', '  1. Install', '  2. Build', '  3. Test', '', '❯ ']),
    ).toBeUndefined();
  });
});
