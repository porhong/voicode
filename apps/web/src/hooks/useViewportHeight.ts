import { useEffect } from 'react';

/**
 * Keeps `--app-height` / `--app-top` equal to the visible viewport. iOS Safari overlays
 * the on-screen keyboard instead of resizing the page, so a `100%`-tall layout would
 * hide the composer behind it; the visual viewport shrinks with the keyboard on every
 * browser. Pinch zoom also shrinks it, so the height is scaled back up, and updates
 * are skipped while zoomed in so the layout doesn't jump around under the fingers.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      if (vv.scale > 1.01) return;
      root.style.setProperty('--app-height', `${Math.round(vv.height * vv.scale)}px`);
      root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
      // iOS scrolls the page to reveal a focused input; the layout already fits.
      if (window.scrollY) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, []);
}
