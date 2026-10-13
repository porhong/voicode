import { useEffect, useState } from 'react';
import type { AgentInfoResponse } from '@voicecode/protocol';
import { api } from './lib/api';
import { ControllerPage } from './pages/ControllerPage';
import { PairPage } from './pages/PairPage';

type View =
  | { kind: 'loading' }
  | { kind: 'offline' }
  | { kind: 'pair' | 'controller'; info: AgentInfoResponse };

export function App() {
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

  switch (view.kind) {
    case 'loading':
      return <main className="center muted">Connecting…</main>;
    case 'offline':
      return (
        <main className="center">
          <p>Can’t reach the VoiceCode agent.</p>
          <button className="btn" onClick={recheck}>
            Retry
          </button>
        </main>
      );
    case 'pair':
      return <PairPage hostname={view.info.hostname} onPaired={recheck} />;
    case 'controller':
      return <ControllerPage onUnpaired={recheck} />;
  }
}
