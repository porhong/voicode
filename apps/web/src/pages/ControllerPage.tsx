import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ServerMessage } from '@voicecode/protocol';
import { Composer, type ComposerHandle } from '../components/Composer';
import { Deck, type DeckStatus } from '../components/Deck';
import { DeckEditor } from '../components/DeckEditor';
import { FolderSheet } from '../components/FolderSheet';
import { ChatIcon, DeckPadIcon, GearIcon } from '../components/Icons';
import { PermissionCard } from '../components/PermissionCard';
import { SessionBar, StartSession, useProjectChoice } from '../components/SessionBar';
import { Toasts } from '../components/Toasts';
import { SettingsSheet } from '../components/SettingsSheet';
import { Trackpad } from '../components/Trackpad';
import { Transcript, type TranscriptHandle } from '../components/Transcript';
import { useAgentSocket } from '../hooks/useAgentSocket';
import { useApprovalAlerts } from '../hooks/useApprovalAlerts';
import { useDeck, type Macro } from '../hooks/useDeck';
import { speechRecognitionSupported } from '../hooks/useSpeechRecognition';
import { useSpeakReplies } from '../hooks/useSpeakReplies';
import { useSettings } from '../hooks/useSettings';
import { useWakeLock } from '../hooks/useWakeLock';
import { initialState, reducer, type Toast } from '../lib/store';

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
  const transcriptRef = useRef<TranscriptHandle>(null);
  const [deck, saveDeck] = useDeck();
  const [deckEditorOpen, setDeckEditorOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const deckMode = settings.claudeLayout === 'deck';

  const onMessage = useCallback(
    (message: ServerMessage) => dispatch({ type: 'server', message }),
    [],
  );
  const { state: connection, send } = useAgentSocket(onMessage);

  useEffect(() => {
    if (connection === 'unpaired') onUnpaired();
  }, [connection, onUnpaired]);

  // Subscribe to whatever is on screen after (re)connecting to get its history.
  useEffect(() => {
    if (connection !== 'open') return;
    if (state.activePcSessionId) {
      send({ type: 'pc.session.subscribe', sessionId: state.activePcSessionId });
    } else if (state.activeSessionId) {
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

  const pcId = state.activePcSessionId;
  const pc = pcId ? state.pcSessions.find((p) => p.sessionId === pcId) : undefined;
  const active = !pcId && state.activeSessionId ? state.sessions[state.activeSessionId] : undefined;
  const pcEvents = useMemo(
    () => (pcId ? (state.pcEvents[pcId] ?? []) : []),
    [pcId, state.pcEvents],
  );

  const openSession = (sessionId: string) => {
    if (pcId) send({ type: 'pc.session.unsubscribe' });
    dispatch({ type: 'selectSession', sessionId });
    send({ type: 'claude.session.subscribe', sessionId });
  };
  const openPcSession = (sessionId: string) => {
    dispatch({ type: 'selectPcSession', sessionId });
    send({ type: 'pc.session.subscribe', sessionId });
  };
  const openToast = (toast: Toast) => {
    dispatch({ type: 'dismissToast', id: toast.id });
    setTab('claude');
    if (toast.source === 'pc') openPcSession(toast.sessionId);
    else openSession(toast.sessionId);
  };
  const dismissToast = useCallback((id: number) => dispatch({ type: 'dismissToast', id }), []);

  // Continuing a terminal session forks it into a phone session. A folder that isn't
  // allow-listed yet is added only after an explicit confirmation here.
  const continuePc = () => {
    if (!pc) return;
    if (!pc.projectId) {
      const ok = confirm(
        `Allow Claude to work in this folder from your phone?\n\n${pc.cwd}\n\nEvery tool call still needs your approval.`,
      );
      if (!ok) return;
    }
    send({ type: 'pc.session.continue', sessionId: pc.sessionId, allowFolder: !pc.projectId });
  };

  // A light tap when a task finishes somewhere else.
  const lastToast = useRef(state.toasts[0]?.id ?? 0);
  useEffect(() => {
    const newest = state.toasts[0]?.id ?? 0;
    if (newest > lastToast.current) navigator.vibrate?.(20);
    lastToast.current = Math.max(lastToast.current, newest);
  }, [state.toasts]);

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
  const openFolder = state.roots.length ? () => setFoldersOpen(true) : undefined;
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
        onOpenFolder={openFolder}
      />
      <button className="link" onClick={() => setSessionsOpen(true)}>
        Resume an earlier session
      </button>
    </div>
  ) : deckMode ? (
    <div className="empty-card">
      <h2>What should Claude do?</h2>
      <p className="muted">
        Press a key, push the joystick, or hold the mic key and speak. The sliders button on the
        deck changes what each control does.
      </p>
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

  const approval = activePermissions[0];
  const lastEvent = activeEvents[activeEvents.length - 1]?.event;
  const deckStatus: DeckStatus = pcId
    ? 'pc'
    : !active
      ? 'none'
      : active.state === 'idle' && lastEvent?.kind === 'result'
        ? lastEvent.isError
          ? 'error'
          : 'done'
        : active.state;
  const canPrompt = connection === 'open' && !!live;
  const respond = (decision: 'allow' | 'deny') =>
    approval &&
    send({
      type: 'claude.permission.respond',
      sessionId: approval.sessionId,
      requestId: approval.requestId,
      decision,
      rememberForSession: false,
    });
  const runMacro = (macro: Macro) => {
    if (!active || !canPrompt) return;
    if (macro.review) composerRef.current?.setDraft(macro.prompt);
    else send({ type: 'claude.prompt', sessionId: active.id, text: macro.prompt });
  };
  const newSession = () => {
    const projectId = active?.projectId ?? startProjectId;
    if (projectId) startSession(projectId);
    else if (openFolder) openFolder();
    else setSessionsOpen(true);
  };

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
        {tab === 'claude' && (
          <button
            className="icon-button"
            onClick={() => updateSettings({ claudeLayout: deckMode ? 'chat' : 'deck' })}
            aria-label={deckMode ? 'Switch to chat layout' : 'Switch to deck layout'}
            title={deckMode ? 'Chat layout' : 'Deck layout'}
          >
            {deckMode ? <ChatIcon /> : <DeckPadIcon />}
          </button>
        )}
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
        <main className={deckMode ? 'claude claude-deck' : 'claude'}>
          <div className="claude-column">
            <SessionBar
              disabled={connection !== 'open'}
              state={state}
              send={send}
              sheetOpen={sessionsOpen}
              onSheetOpenChange={setSessionsOpen}
              onSelect={openSession}
              onSelectPc={openPcSession}
              onOpenFolder={openFolder}
            />
            {pcId ? (
              <Transcript
                ref={transcriptRef}
                key={`pc-${pcId}`}
                events={pcEvents}
                streaming=""
                empty={
                  <div className="empty-card">
                    <p className="muted">No messages in this session yet.</p>
                  </div>
                }
              />
            ) : (
              <Transcript
                ref={transcriptRef}
                key={active?.id ?? 'none'}
                events={activeEvents}
                streaming={active ? (state.streaming[active.id] ?? '') : ''}
                empty={emptyState}
              />
            )}
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
            {pcId && (
              <div className="pc-bar">
                {pc ? (
                  <>
                    <p className="pc-bar-text">
                      <strong>Running in a terminal on the PC.</strong>{' '}
                      <span className="muted">
                        {pc.status === 'working' || pc.status === 'waiting'
                          ? 'You can continue it here once it finishes.'
                          : 'Continue it here as a copy; the terminal keeps its own.'}
                      </span>
                    </p>
                    <button
                      className="btn btn-primary"
                      disabled={
                        connection !== 'open' || pc.status === 'working' || pc.status === 'waiting'
                      }
                      onClick={continuePc}
                    >
                      Continue on phone
                    </button>
                  </>
                ) : (
                  <p className="pc-bar-text muted">This session has ended on the PC.</p>
                )}
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
                compact={deckMode}
                onListeningChange={setListening}
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
          </div>
          {deckMode && (
            <Deck
              deck={deck}
              status={deckStatus}
              canPrompt={canPrompt}
              connected={connection === 'open'}
              running={active?.state === 'running' || active?.state === 'awaiting_permission'}
              approval={approval}
              micSupported={speechRecognitionSupported()}
              listening={canPrompt && listening}
              onMacro={runMacro}
              onAccept={() => respond('allow')}
              onReject={() => respond('deny')}
              onStop={() => active && send({ type: 'claude.interrupt', sessionId: active.id })}
              onNew={newSession}
              onType={() => composerRef.current?.focus()}
              onSessions={() => setSessionsOpen(true)}
              onCustomize={() => setDeckEditorOpen(true)}
              onPushToTalk={(pressed) => composerRef.current?.pushToTalk(pressed)}
              onScroll={(dy) => transcriptRef.current?.scrollBy(dy)}
              onLatest={() => transcriptRef.current?.toEnd()}
            />
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

      <Toasts toasts={state.toasts} onOpen={openToast} onDismiss={dismissToast} />

      {foldersOpen && (
        <FolderSheet
          state={state}
          send={send}
          disabled={connection !== 'open'}
          onClose={() => setFoldersOpen(false)}
        />
      )}

      {deckEditorOpen && (
        <DeckEditor deck={deck} onChange={saveDeck} onClose={() => setDeckEditorOpen(false)} />
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
