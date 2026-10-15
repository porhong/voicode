import { describe, expect, it } from 'vitest';
import type { EventItem, Toast } from '../lib/store';
import {
  evaluateStateTransition,
  evaluateStreamEvent,
  evaluateToastAlert,
  type StreamPosition,
} from './useAlertSounds';

describe('useAlertSounds evaluation', () => {
  const baseTime = 1_000_000;

  it('synchronises position on initial attach without playing sounds for existing history', () => {
    const history: EventItem[] = [
      { seq: 1, at: baseTime, event: { kind: 'user_prompt', text: 'hi', deviceName: 'phone' } },
      {
        seq: 2,
        at: baseTime + 100,
        event: {
          kind: 'result',
          subtype: 'complete',
          isError: false,
          durationMs: 100,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    const result = evaluateStreamEvent('s1', history, null, true, baseTime + 200);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 2 });
    expect(result.sound).toBeNull();
  });

  it('switches sessions and updates position without alerting on past events', () => {
    const prevPosition: StreamPosition = { sessionId: 's1', seq: 5 };
    const newSessionEvents: EventItem[] = [
      {
        seq: 10,
        at: baseTime,
        event: {
          kind: 'result',
          subtype: 'complete',
          isError: false,
          durationMs: 50,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    const result = evaluateStreamEvent('s2', newSessionEvents, prevPosition, true, baseTime + 100);
    expect(result.nextPosition).toEqual({ sessionId: 's2', seq: 10 });
    expect(result.sound).toBeNull();
  });

  it('triggers "done" alert sound when a fresh result arrives successfully', () => {
    const position: StreamPosition = { sessionId: 's1', seq: 2 };
    const events: EventItem[] = [
      {
        seq: 3,
        at: baseTime,
        event: {
          kind: 'result',
          subtype: 'complete',
          isError: false,
          durationMs: 200,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    const result = evaluateStreamEvent('s1', events, position, true, baseTime + 500);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 3 });
    expect(result.sound).toBe('done');
  });

  it('triggers "error" alert sound when a turn result has an error', () => {
    const position: StreamPosition = { sessionId: 's1', seq: 2 };
    const events: EventItem[] = [
      {
        seq: 3,
        at: baseTime,
        event: {
          kind: 'result',
          subtype: 'error',
          isError: true,
          durationMs: 200,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    const result = evaluateStreamEvent('s1', events, position, true, baseTime + 500);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 3 });
    expect(result.sound).toBe('error');
  });

  it('triggers "error" alert sound when an error event arrives', () => {
    const position: StreamPosition = { sessionId: 's1', seq: 2 };
    const events: EventItem[] = [
      { seq: 3, at: baseTime, event: { kind: 'error', message: 'Rate limit exceeded' } },
    ];

    const result = evaluateStreamEvent('s1', events, position, true, baseTime + 500);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 3 });
    expect(result.sound).toBe('error');
  });

  it('does not alert on stale events older than 60 seconds', () => {
    const position: StreamPosition = { sessionId: 's1', seq: 2 };
    const events: EventItem[] = [
      {
        seq: 3,
        at: baseTime,
        event: {
          kind: 'result',
          subtype: 'complete',
          isError: false,
          durationMs: 100,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    // 70 seconds later
    const result = evaluateStreamEvent('s1', events, position, true, baseTime + 70_000);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 3 });
    expect(result.sound).toBeNull();
  });

  it('does not alert when sound alerts are disabled in settings', () => {
    const position: StreamPosition = { sessionId: 's1', seq: 2 };
    const events: EventItem[] = [
      {
        seq: 3,
        at: baseTime,
        event: {
          kind: 'result',
          subtype: 'complete',
          isError: false,
          durationMs: 100,
          totalCostUsd: 0,
          numTurns: 1,
        },
      },
    ];

    const result = evaluateStreamEvent('s1', events, position, false, baseTime + 500);
    expect(result.nextPosition).toEqual({ sessionId: 's1', seq: 3 });
    expect(result.sound).toBeNull();
  });

  it('detects session lifecycle error transitions', () => {
    expect(
      evaluateStateTransition('s1', 'error', { sessionId: 's1', state: 'running' }, true),
    ).toBe('error');

    // Already error: no re-alert
    expect(
      evaluateStateTransition('s1', 'error', { sessionId: 's1', state: 'error' }, true),
    ).toBeNull();

    // Disabled in settings
    expect(
      evaluateStateTransition('s1', 'error', { sessionId: 's1', state: 'running' }, false),
    ).toBeNull();
  });

  it('evaluates background toast arrivals for task completion and errors', () => {
    const doneToast: Toast = {
      id: 5,
      source: 'pc',
      sessionId: 'p1',
      place: 'backend',
      title: 'tests passed',
      isError: false,
    };

    const errorToast: Toast = {
      id: 6,
      source: 'agent',
      sessionId: 's2',
      place: 'frontend',
      title: 'build failed',
      isError: true,
    };

    // New success toast with sound enabled
    expect(evaluateToastAlert([doneToast], 4, true)).toEqual({
      sound: 'done',
      fallbackVibrate: false,
    });

    // New error toast with sound enabled
    expect(evaluateToastAlert([errorToast], 5, true)).toEqual({
      sound: 'error',
      fallbackVibrate: false,
    });

    // When sound is disabled: fallback vibration is flagged
    expect(evaluateToastAlert([doneToast], 4, false)).toEqual({
      sound: null,
      fallbackVibrate: true,
    });

    // Older toast: ignored
    expect(evaluateToastAlert([doneToast], 5, true)).toEqual({
      sound: null,
      fallbackVibrate: false,
    });
  });
});
