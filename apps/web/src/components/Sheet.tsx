import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Modal bottom sheet (a centred dialog on wide screens). Closes on the backdrop, the
 * close button or Escape. It is portalled to <body> so the rest of the app can be made
 * `inert` while it is open (Tab and screen readers stay inside); focus returns to the
 * opener afterwards.
 */
export function Sheet({ title, onClose, children }: Props) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  // Callers pass inline callbacks; reading the latest one keeps the effect mount-only,
  // so a re-render (every server message) never steals focus back to the sheet.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const app = document.querySelector<HTMLElement>('.app');
    app?.setAttribute('inert', '');
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      app?.removeAttribute('inert');
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="sheet-backdrop" onClick={() => closeRef.current()}>
      <section
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" aria-hidden />
        <header className="sheet-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-button" onClick={() => closeRef.current()} aria-label="Close">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
