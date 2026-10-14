import { describe, expect, it } from 'vitest';
import { readVoiceScreen } from './voice-screen.js';

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
      readVoiceScreen(['Do you trust the files in this folder?', '❯ Yes, proceed']),
    ).toMatchObject({ dialog: 'Do you trust the files in this folder?' });
    expect(readVoiceScreen(['> hello']).dialog).toBeUndefined();
  });
});
