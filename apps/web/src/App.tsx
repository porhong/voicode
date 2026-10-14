import { useEffect, useState } from 'react';
import type { AgentInfoResponse } from '@voicecode/protocol';
import { useViewportHeight } from './hooks/useViewportHeight';
import { api } from './lib/api';
import { ControllerPage } from './pages/ControllerPage';
import { PairPage } from './pages/PairPage';

type View =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'pair' | 'controller'; info: AgentInfoResponse };

/** While the agent is unreachable (PC asleep, agent restarting), check again this often. */
const OFFLINE_RETRY_MS = 4_000;

export function App() {
  useViewportHeight();
  const [view, setView] = useState<View>({ kind: 'loading' });
  // Bumping this re-checks pairing status (after pairing, unpairing or a retry).
  const [checks, setChecks] = useState(0);
  const recheck = () => setChecks((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    api.info().then(
      (info) => !cancelled && setView({ kind: info.paired ? 'controller' : 'pair', info }),
      () => !cancelled && setView({ kind: 'offline' }),
    );
    return () => {
      cancelled = true;
    };
  }, [checks]);

  // Retry on a timer while visible, and right away when the page or network comes back.
  useEffect(() => {
    if (view.kind !== 'offline') return;
    const retry = () => document.visibilityState === 'visible' && recheck();
    const timer = window.setInterval(retry, OFFLINE_RETRY_MS);
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('online', retry);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('online', retry);
    };
  }, [view.kind]);

  switch (view.kind) {
    case 'loading':
      return (
        <main className="center">
          <img src="/icon.svg" alt="" width={64} height={64} className="pulse-soft" />
          <p className="muted">Connecting…</p>
        </main>
      );
    case 'offline':
      return (
        <main className="center">
          <img src="/icon.svg" alt="" width={64} height={64} className="dimmed" />
          <h1 className="center-title">Can’t reach your PC</h1>
          <p className="muted">
            Make sure <code>voicecode-agent start</code> is running and this device can reach it.
            Retrying automatically…
          </p>
          <button className="btn" onClick={recheck}>
            Retry now
          </button>
        </main>
      );
    case 'pair':
      return <PairPage hostname={view.info.hostname} onPaired={recheck} />;
    case 'controller':
      return <ControllerPage onUnpaired={recheck} />;
  }
}
