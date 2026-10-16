import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO, type VoiceMicStatus } from '@voicecode/protocol';
import { createDownsampler } from '../lib/pcm';
import type { Send } from './useAgentSocket';

/** Hold the microphone open this long after the last use, so the next press is instant. */
const IDLE_RELEASE_MS = 60_000;

export interface MicStream {
  /** This browser can capture audio and the agent has a virtual microphone. */
  supported: boolean;
  /** Why it is not supported, when it isn't. */
  unavailableReason?: string;
  /** Audio is being streamed to the PC right now. */
  active: boolean;
  error?: string;
  /** `attachments`: images to send with what is said (see `takesImages`). */
  start: (attachments?: string[]) => void;
  stop: () => void;
  /**
   * The session on screen takes images with the dictation (a Claude Code terminal
   * session: the agent types them into its prompt while it records).
   */
  takesImages?: boolean;
}

export const micCaptureSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof AudioWorkletNode !== 'undefined';

/**
 * Streams the phone's microphone to the agent as raw PCM while `active`, for Claude
 * Code's own dictation on the PC. Audio never goes through a speech API here: it is
 * captured with an AudioWorklet, downsampled to the wire format and sent as binary
 * WebSocket frames after the microphone lease is taken with `voice.mic.start`.
 */
export function useMicStream(options: {
  send: Send;
  sendBinary: (data: ArrayBuffer) => void;
  mic: { status: VoiceMicStatus; youHoldLease: boolean };
}): MicStream {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string>();
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const capturing = useRef(false);
  const hadLease = useRef(false);
  const audio = useRef<
    | {
        context: AudioContext;
        stream: MediaStream;
        node: AudioWorkletNode;
        source: MediaStreamAudioSourceNode;
      }
    | undefined
  >(undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  const starting = useRef<Promise<void> | undefined>(undefined);

  const releaseHardware = useCallback(() => {
    window.clearTimeout(idleTimer.current);
    const a = audio.current;
    audio.current = undefined;
    if (!a) return;
    a.source.disconnect();
    a.node.disconnect();
    a.node.port.onmessage = null;
    for (const track of a.stream.getTracks()) track.stop();
    void a.context.close().catch(() => undefined);
  }, []);

  const acquireHardware = useCallback(async () => {
    if (audio.current) return audio.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const context = new AudioContext();
    try {
      await context.audioWorklet.addModule('/pcm-worklet.js');
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      throw err;
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    // The context may run at any rate (phones: 44.1 or 48 kHz); the agent takes 16 kHz.
    const downsample = createDownsampler(context.sampleRate, AUDIO.sampleRate);
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!capturing.current) return;
      const pcm = downsample(event.data);
      if (pcm.length) optionsRef.current.sendBinary(pcm.buffer as ArrayBuffer);
    };
    source.connect(node);
    // The worklet writes no output; this just keeps it processing on every browser.
    node.connect(context.destination);
    audio.current = { context, stream, node, source };
    return audio.current;
  }, []);

  const stop = useCallback(() => {
    if (!capturing.current) return;
    capturing.current = false;
    setActive(false);
    optionsRef.current.send({ type: 'voice.mic.stop' });
    void audio.current?.context.suspend().catch(() => undefined);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(releaseHardware, IDLE_RELEASE_MS);
  }, [releaseHardware]);

  const start = useCallback(() => {
    if (capturing.current || starting.current) return;
    const { mic } = optionsRef.current;
    if (!mic.status.available) {
      setError(`The PC has no virtual microphone: ${mic.status.reason ?? 'unknown'}`);
      return;
    }
    setError(undefined);
    window.clearTimeout(idleTimer.current);
    starting.current = (async () => {
      try {
        // The lease is requested first so a refusal arrives before any audio is captured.
        optionsRef.current.send({ type: 'voice.mic.start', sampleRate: AUDIO.sampleRate });
        const a = await acquireHardware();
        await a.context.resume();
        capturing.current = true;
        setActive(true);
      } catch (err) {
        optionsRef.current.send({ type: 'voice.mic.stop' });
        setError(describeMicError(err));
      } finally {
        starting.current = undefined;
      }
    })();
  }, [acquireHardware]);

  // Streaming stops if the agent takes the lease away (another device, idle, restart).
  const youHold = options.mic.youHoldLease;
  useEffect(() => {
    if (youHold) hadLease.current = true;
    else if (hadLease.current) {
      hadLease.current = false;
      if (capturing.current) {
        capturing.current = false;
        setActive(false);
        void audio.current?.context.suspend().catch(() => undefined);
        setError('The PC stopped the microphone');
      }
    }
  }, [youHold]);

  // Let go of the microphone when the page is hidden (privacy, battery) or unmounted.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        stop();
        releaseHardware();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      releaseHardware();
    };
  }, [stop, releaseHardware]);

  const supported = micCaptureSupported() && options.mic.status.available;
  return {
    supported,
    unavailableReason: micCaptureSupported()
      ? options.mic.status.reason
      : 'This browser cannot capture microphone audio',
    active,
    error,
    start,
    stop,
  };
}

function describeMicError(err: unknown): string {
  const name = (err as { name?: string } | undefined)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in the browser settings (the page must be HTTPS and trusted).';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return `Could not start the microphone: ${(err as Error)?.message ?? String(err)}`;
}
