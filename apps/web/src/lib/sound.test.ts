import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audioSupported,
  getAudioContext,
  playAlertSound,
  setAudioContextForTest,
  unlockAudio,
} from './sound';

describe('sound alerts', () => {
  let mockOscillator: {
    type: string;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  let mockGain: {
    gain: {
      setValueAtTime: ReturnType<typeof vi.fn>;
      exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
    };
    connect: ReturnType<typeof vi.fn>;
  };

  let mockCtx: {
    state: string;
    currentTime: number;
    destination: Record<string, unknown>;
    createOscillator: ReturnType<typeof vi.fn>;
    createGain: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  };

  let mockVibrate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOscillator = {
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };

    mockGain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };

    mockCtx = {
      state: 'running',
      currentTime: 10,
      destination: {},
      createOscillator: vi.fn(() => ({ ...mockOscillator })),
      createGain: vi.fn(() => ({ ...mockGain })),
      resume: vi.fn().mockResolvedValue(undefined),
    };

    mockVibrate = vi.fn();

    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => mockCtx),
    );
    setAudioContextForTest(mockCtx as unknown as AudioContext);

    if (typeof navigator !== 'undefined') {
      Object.defineProperty(navigator, 'vibrate', {
        value: mockVibrate,
        configurable: true,
        writable: true,
      });
    } else {
      vi.stubGlobal('navigator', { vibrate: mockVibrate });
    }
  });

  afterEach(() => {
    setAudioContextForTest(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('detects audio support when AudioContext is present', () => {
    expect(audioSupported()).toBe(true);
    expect(getAudioContext()).toBeDefined();
  });

  it('plays done chime with ascending frequencies and haptic tap', () => {
    playAlertSound('done', true);

    expect(mockVibrate).toHaveBeenCalledWith(35);
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
    expect(mockCtx.createGain).toHaveBeenCalledTimes(3); // 2 notes + 1 master
  });

  it('plays error tone with warning frequencies and error vibration pattern', () => {
    playAlertSound('error', true);

    expect(mockVibrate).toHaveBeenCalledWith([60, 40, 80]);
    expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('resumes suspended context when playing a sound', () => {
    mockCtx.state = 'suspended';
    playAlertSound('done', true);

    expect(mockCtx.resume).toHaveBeenCalled();
  });

  it('throttles rapid duplicate sounds of the same type', () => {
    playAlertSound('done', true);
    const initialCallCount = mockCtx.createOscillator.mock.calls.length;

    // Immediately play again without force
    playAlertSound('done', false);
    expect(mockCtx.createOscillator.mock.calls.length).toBe(initialCallCount);

    // With force=true, it should play
    playAlertSound('done', true);
    expect(mockCtx.createOscillator.mock.calls.length).toBeGreaterThan(initialCallCount);
  });

  it('unlocks audio context if suspended', () => {
    mockCtx.state = 'suspended';
    unlockAudio();
    expect(mockCtx.resume).toHaveBeenCalled();
  });
});
