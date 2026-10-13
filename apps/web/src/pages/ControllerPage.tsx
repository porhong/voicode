import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { ServerMessage } from '@voicecode/protocol';
import { Composer } from '../components/Composer';
import { PermissionCard } from '../components/PermissionCard';
import { SessionBar } from '../components/SessionBar';
import { SettingsSheet } from '../components/SettingsSheet';
import { Trackpad } from '../components/Trackpad';
import { Transcript } from '../components/Transcript';
import { useAgentSocket } from '../hooks/useAgentSocket';
import { useApprovalAlerts } from '../hooks/useApprovalAlerts';
import { useSettings } from '../hooks/useSettings';
import { useWakeLock } from '../hooks/useWakeLock';
import { initialState, reducer } from '../lib/store';

type Tab = 'claude' | 'trackpad';

export function ControllerPage({ onUnpaired }: { onUnpaired: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [tab, setTab] = useState<Tab>('claude');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, updateSettings] = useSettings();

  const onMessage = useCallback(
    (message: ServerMessage) => dispatch({ type: 'server', message }),
    [],
  );
  const { state: connection, send } = useAgentSocket(onMessage);

  useEffect(() => {
    if (connection === 'unpaired') onUnpaired();
  }, [connection, onUnpaired]);

  // Subscribe to the active session after (re)connecting to get its history.
  useEffect(() => {
    if (connection === 'open' && state.activeSessionId) {
      send({ type: 'claude.session.subscribe', sessionId: state.activeSessionId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on (re)connect
  }, [connection, state.agent]);

  // Release the mouse when leaving the trackpad so another device can use it.
  useEffect(() => {
    if (tab !== 'trackpad' && state.mouse.youHoldLease) send({ type: 'mouse.release' });
  }, [tab, state.mouse.youHoldLease, send]);

  useWakeLock(tab === 'trackpad');

  useEffect(() => {
    if (!state.error) return;
    const timer = window.setTimeout(() => dispatch({ type: 'dismissError' }), 4000);
    return () => window.clearTimeout(timer);
  }, [state.error]);

  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined;
  const permissions = useMemo(
    () => Object.values(state.permissions).sort((a, b) => a.createdAt - b.createdAt),
    [state.permissions],
  );
  useApprovalAlerts(permissions, settings.notifyApprovals);
  const activePermissions = permissions.filter((p) => p.sessionId === active?.id);
  const otherPermissions = permissions.length - activePermissions.length;
  const live = active && active.state !== 'closed' && active.state !== 'error';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className={`dot dot-${connection}`} aria-label={connection} />
          <span>{state.agent?.hostname ?? 'Connecting…'}</span>
        </div>
        <nav className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'claude'}
            className={tab === 'claude' ? 'tab active' : 'tab'}
            onClick={() => setTab('claude')}
          >
            Claude
            {permissions.length > 0 && <span className="tab-badge">{permissions.length}</span>}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'trackpad'}
            className={tab === 'trackpad' ? 'tab active' : 'tab'}
            onClick={() => setTab('trackpad')}
          >
            Trackpad
          </button>
        </nav>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings">
          ⋯
        </button>
      </header>

      {state.protocolMismatch && (
        <button className="banner banner-action" onClick={() => location.reload()}>
          The agent was updated. Tap to reload this page.
        </button>
      )}
      {connection === 'reconnecting' && <div className="banner">Reconnecting to the agent…</div>}
      {state.error && (
        <div
          className="banner banner-error"
          role="alert"
          onClick={() => dispatch({ type: 'dismissError' })}
        >
          {state.error.message}
        </div>
      )}

      {tab === 'claude' ? (
        <main className="claude">
          <SessionBar
            state={state}
            send={send}
            onSelect={(sessionId) => {
              dispatch({ type: 'selectSession', sessionId });
              send({ type: 'claude.session.subscribe', sessionId });
            }}
          />
          <Transcript
            events={active ? (state.events[active.id] ?? []) : []}
            streaming={active ? (state.streaming[active.id] ?? '') : ''}
          />
          {otherPermissions > 0 && (
            <div className="banner">
              {otherPermissions} approval{otherPermissions > 1 ? 's' : ''} waiting in another
              session
            </div>
          )}
          {activePermissions.map((request) => (
            <PermissionCard key={request.requestId} request={request} send={send} />
          ))}
          <Composer
            disabled={connection !== 'open' || !live}
            busy={active?.state === 'running' || active?.state === 'awaiting_permission'}
            settings={settings}
            onSend={(text) => active && send({ type: 'claude.prompt', sessionId: active.id, text })}
            onInterrupt={() => active && send({ type: 'claude.interrupt', sessionId: active.id })}
          />
        </main>
      ) : (
        <main className="trackpad-page">
          {permissions.length > 0 && (
            <button className="banner banner-action" onClick={() => setTab('claude')}>
              Claude needs your approval →
            </button>
          )}
          <Trackpad send={send} mouse={state.mouse} settings={settings} />
        </main>
      )}

      {settingsOpen && (
        <SettingsSheet
          settings={settings}
          update={updateSettings}
          device={state.device}
          agentVersion={state.agent?.version}
          onClose={() => setSettingsOpen(false)}
          onUnpaired={onUnpaired}
        />
      )}
    </div>
  );
}
