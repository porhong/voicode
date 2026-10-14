import { useEffect } from 'react';
import type { Toast } from '../lib/store';

/** How long a toast stays up unless tapped. */
const TOAST_MS = 6_000;

function ToastItem({
  toast,
  onOpen,
  onDismiss,
}: {
  toast: Toast;
  onOpen: (toast: Toast) => void;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <li className={`toast ${toast.isError ? 'toast-error' : ''}`}>
      <button className="toast-main" onClick={() => onOpen(toast)}>
        <span className="toast-icon" aria-hidden>
          {toast.isError ? '!' : '✓'}
        </span>
        <span className="toast-text">
          <span className="toast-title">
            {toast.isError ? 'Stopped' : 'Done'} · {toast.place}
            {toast.source === 'pc' && <span className="toast-tag">PC</span>}
          </span>
          {toast.title && <span className="toast-body">{toast.title}</span>}
        </span>
      </button>
      <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </li>
  );
}

/**
 * "Task finished" notices for sessions that are not on screen (phone sessions and
 * Claude sessions in terminals on the PC). Tapping one opens that session.
 */
export function Toasts({
  toasts,
  onOpen,
  onDismiss,
}: {
  toasts: Toast[];
  onOpen: (toast: Toast) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <ul className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}
