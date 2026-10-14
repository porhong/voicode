import { existsSync } from 'node:fs';
import { AUDIO } from '@voicecode/protocol';
import type { AgentConfig } from '../config/config.js';
import { nativeHelperCandidates } from '../mouse/resolve-driver.js';
import type { Logger } from '../util/logger.js';
import { HelperAudioDriver } from './helper-audio-driver.js';
import type { MicDriverCandidate } from './mic-router.js';
import { PipeWireDriver } from './pipewire-driver.js';

export const WINDOWS_AUDIO_HELPER = 'voicecode-audio-out.exe';

/** Where the Windows audio helper is, if it was built or shipped. */
export function windowsAudioHelper(): string | undefined {
  return nativeHelperCandidates(WINDOWS_AUDIO_HELPER, 'windows').find((p) => existsSync(p));
}

/** The install hint shown when no virtual microphone is available. */
export function virtualMicSetupHint(): string {
  return process.platform === 'win32'
    ? 'Install VB-CABLE (vb-audio.com/Cable) and make "CABLE Output" the default recording device'
    : 'Install PipeWire with pipewire-pulse (pactl and pw-cat must be on PATH)';
}

/**
 * Ordered backends for the virtual microphone on this platform. Windows plays into a
 * VB-CABLE playback device through the native helper; Linux uses a PipeWire null sink.
 */
export function micDriverCandidates(
  config: AgentConfig,
  logger: Logger,
): { candidates: MicDriverCandidate[]; unavailableReason?: string } {
  if (config.voice.mode === 'off') {
    return { candidates: [], unavailableReason: 'disabled in config' };
  }
  const candidates: MicDriverCandidate[] = [];
  if (process.platform === 'win32') {
    const exe = windowsAudioHelper();
    if (exe) {
      candidates.push({
        name: 'win32-waveout',
        create: () =>
          new HelperAudioDriver(
            'win32-waveout',
            exe,
            ['--device', config.voice.outputDevice, '--rate', String(AUDIO.sampleRate)],
            logger,
          ),
      });
    }
    return {
      candidates,
      unavailableReason: exe ? undefined : 'the audio helper (voicecode-audio-out.exe) is missing',
    };
  }
  if (process.platform === 'linux') {
    candidates.push({
      name: 'pipewire',
      create: () => new PipeWireDriver(config.voice.sink, logger),
    });
    return { candidates };
  }
  return { candidates, unavailableReason: `no virtual microphone backend for ${process.platform}` };
}
