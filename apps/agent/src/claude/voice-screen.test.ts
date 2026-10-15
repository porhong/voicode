import { describe, expect, it } from 'vitest';
import { readPermissionMode, readVoiceScreen } from './voice-screen.js';

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
