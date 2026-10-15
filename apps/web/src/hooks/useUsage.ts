import { useEffect, useRef } from 'react';
import type { Send } from './useAgentSocket';

/** While shown, the limits are read again this often (the agent caches for a minute). */
const POLL_MS = 2 * 60_000;

/**
 * Keeps the plan's usage limits fresh while something on screen shows them: on show,
 * every couple of minutes while the page is visible, and right after a turn ends
 * (that is when they move).
 */
export function useUsage(send: Send, connected: boolean, shown: boolean, working: boolean) {
  useEffect(() => {
    if (!connected || !shown) return;
    send({ type: 'claude.usage' });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') send({ type: 'claude.usage' });
    }, POLL_MS);
    const onVisible = () =>
      document.visibilityState === 'visible' && send({ type: 'claude.usage' });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [send, connected, shown]);

  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working && connected && shown) {
      send({ type: 'claude.usage', refresh: true });
    }
    wasWorking.current = working;
  }, [send, connected, shown, working]);
}
