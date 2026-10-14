import { useCallback, useEffect, useRef, useState } from 'react';

export type OrientationChoice = 'auto' | 'portrait' | 'landscape';

/** `lock()` is missing from TypeScript's DOM types: only some browsers implement it. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'portrait' | 'landscape') => Promise<void>;
};

export const orientationSupported = () => typeof screen !== 'undefined' && 'orientation' in screen;

/**
 * Locks the screen to portrait or landscape through the Screen Orientation API.
 * Installed PWAs on Android can lock straight away; a browser tab has to be fullscreen
 * first, so that is tried next (the tap that asked for it is the user activation it
 * needs). iOS has no lock at all, so the caller is told it failed rather than pretending.
 * Leaving fullscreen (back gesture, Esc) drops the lock, and the choice follows.
 */
export function useOrientationLock() {
  const [choice, setChoice] = useState<OrientationChoice>('auto');
  const ownFullscreen = useRef(false);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && ownFullscreen.current) {
        ownFullscreen.current = false;
        setChoice('auto');
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const apply = useCallback(async (next: OrientationChoice): Promise<boolean> => {
    const orientation = screen.orientation as LockableOrientation | undefined;
    if (next === 'auto') {
      orientation?.unlock?.();
      if (ownFullscreen.current && document.fullscreenElement) {
        ownFullscreen.current = false;
        await document.exitFullscreen().catch(() => undefined);
      }
      setChoice('auto');
      return true;
    }
    if (!orientation?.lock) return false;
    try {
      await orientation.lock(next);
    } catch {
      if (document.fullscreenElement || !document.documentElement.requestFullscreen) return false;
      try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        ownFullscreen.current = true;
        await orientation.lock(next);
      } catch {
        if (ownFullscreen.current) {
          ownFullscreen.current = false;
          await document.exitFullscreen().catch(() => undefined);
        }
        return false;
      }
    }
    setChoice(next);
    return true;
  }, []);

  return [choice, apply] as const;
}
