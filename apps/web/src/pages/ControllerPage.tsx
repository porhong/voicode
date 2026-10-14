import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ServerMessage } from '@voicecode/protocol';
import { Composer, type ComposerHandle } from '../components/Composer';
import { GearIcon } from '../components/Icons';
import { PermissionCard } from '../components/PermissionCard';
import { SessionBar, StartSession, useProjectChoice } from '../components/SessionBar';
import { SettingsSheet } from '../components/SettingsSheet';
import { Trackpad } from '../components/Trackpad';
import { Transcript } from '../components/Transcript';
import { useAgentSocket } from '../hooks/useAgentSocket';
import { useApprovalAlerts } from '../hooks/useApprovalAlerts';
import { useSpeakReplies } from '../hooks/useSpeakReplies';
import { useSettings } from '../hooks/useSettings';
import { useWakeLock } from '../hooks/useWakeLock';
import { initialState, reducer } from '../lib/store';

type Tab = 'claude' | 'trackpad';

const CONNECTION_LABEL = {
  connecting: 'Connecting',
  open: 'Connected',
  reconnecting: 'Reconnecting',
  unpaired: 'Not paired',
} as const;

/** One tap fills the composer; the prompt can still be edited before sending. */
const SUGGESTIONS = [
  'Give me a quick overview of this project',
  'Run the tests and fix any failures',
  'What changed since the last commit?',
];

export function ControllerPage({ onUnpaired }: { onUnpaired: () => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [tab, setTab] = useState<Tab>('claude');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settings, updateSettings] = useSettings();
  const composerRef = useRef<ComposerHandle>(null);

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
  const activeEvents = useMemo(
    () => (active ? (state.events[active.id] ?? []) : []),
    [active, state.events],
  );
  useSpeakReplies(active?.id, activeEvents, settings.speakReplies, settings.voiceLang);
  const activePermissions = permissions.filter((p) => p.sessionId === active?.id);
  const otherPermissions = permissions.length - activePermissions.length;
  const live = active && active.state !== 'closed' && active.state !== 'error';
  const [startProjectId, setStartProjectId] = useProjectChoice(state.projects, active?.projectId);
  const startSession = (projectId: string) => send({ type: 'claude.session.start', projectId });

  // A short buzz when a new approval arrives, so a phone in hand notices it.
  // Approvals re-sent after a reconnect are not new, so only buzz while connected.
  const approvalCount = useRef(permissions.length);
  useEffect(() => {
    if (permissions.length > approvalCount.current && connection === 'open') {
      navigator.vibrate?.([30, 60, 30]);
    }
    approvalCount.current = permissions.length;
  }, [permissions.length, connection]);

  const emptyState = !active ? (
    <div className="empty-card">
      <h2>Start talking to Claude</h2>
      <p className="muted">
        Start a session in one of your projects, then speak or type what you want done.
      </p>
      <StartSession
        projects={state.projects}
        projectId={startProjectId}
        onProjectChange={setStartProjectId}
        disabled={connection !== 'open'}
        onStart={() => startSession(startProjectId)}
      />
      <button className="link" onClick={() => setSessionsOpen(true)}>
        Resume an earlier session
      </button>
    </div>
  ) : (
    <div className="empty-card">
      <h2>What should Claude do?</h2>
      <p className="muted">Tap the mic and speak, or start from one of these:</p>
      <div className="suggestions">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            className="suggestion"
            disabled={!live}
            onClick={() => composerRef.current?.setDraft(text)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span
            className={`dot dot-${connection}`}
            role="img"
            aria-label={CONNECTION_LABEL[connection]}
            title={CONNECTION_LABEL[connection]}
          />
          <span className="topbar-name">{state.agent?.hostname ?? 'Connecting…'}</span>
        </div>
        <nav className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'claude'}
            className={tab === 'claude' ? 'tab active' : 'tab'}
            onClick={() => setTab('claude')}
          >
            Claude
            {permissions.length > 0 && (
              <span className="tab-badge" aria-label={`${permissions.length} waiting`}>
                {permissions.length}
              </span>
            )}
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
          <GearIcon />
        </button>
      </header>

      {state.protocolMismatch && (
        <button className="banner banner-action" onClick={() => location.reload()}>
          The agent was updated. Tap to reload this page.
        </button>
      )}
      {connection === 'reconnecting' && (
        <div className="banner" role="status">
          Reconnecting to the agent…
        </div>
      )}
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
            disabled={connection !== 'open'}
            state={state}
            send={send}
            sheetOpen={sessionsOpen}
            onSheetOpenChange={setSessionsOpen}
            onSelect={(sessionId) => {
              dispatch({ type: 'selectSession', sessionId });
              send({ type: 'claude.session.subscribe', sessionId });
            }}
          />
          <Transcript
            key={active?.id ?? 'none'}
            events={activeEvents}
            streaming={active ? (state.streaming[active.id] ?? '') : ''}
            empty={emptyState}
          />
          {otherPermissions > 0 && (
            <button className="banner banner-action" onClick={() => setSessionsOpen(true)}>
              {otherPermissions} approval{otherPermissions > 1 ? 's' : ''} waiting in another
              session →
            </button>
          )}
          {activePermissions.length > 0 && (
            // Scrolls on its own on short screens (landscape) so the composer stays visible.
            <div className="approvals">
              {activePermissions.map((request) => (
                <PermissionCard
                  key={request.requestId}
                  request={request}
                  send={send}
                  disabled={connection !== 'open'}
                />
              ))}
            </div>
          )}
          {active && live && (
            <Composer
              ref={composerRef}
              disabled={connection !== 'open'}
              activity={
                active.state === 'running' || active.state === 'awaiting_permission'
                  ? active.state
                  : undefined
              }
              approvalShown={activePermissions.length > 0}
              settings={settings}
              onSend={(text) => send({ type: 'claude.prompt', sessionId: active.id, text })}
              onInterrupt={() => send({ type: 'claude.interrupt', sessionId: active.id })}
            />
          )}
          {active && !live && (
            <div className="session-ended">
              <span className="muted">
                {active.state === 'error'
                  ? 'This session stopped with an error.'
                  : 'Session closed.'}
              </span>
              <button
                className="btn btn-primary btn-small"
                disabled={connection !== 'open'}
                onClick={() => startSession(active.projectId)}
              >
                New session
              </button>
            </div>
          )}
        </main>
      ) : (
        <main className="trackpad-page">
          {permissions.length > 0 && (
            <button className="banner banner-action" onClick={() => setTab('claude')}>
              Claude needs your approval →
            </button>
          )}
          <Trackpad
            send={send}
            mouse={state.mouse}
            settings={settings}
            connected={connection === 'open'}
          />
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
