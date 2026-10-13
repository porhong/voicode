import { useEffect } from 'react';

/** Keeps the screen awake while `active` (e.g. while the trackpad is in use). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | undefined;
    let cancelled = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) void sentinel.release();
      } catch {
        // Denied (battery saver, not visible); nothing to do.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    };
  }, [active]);
}
