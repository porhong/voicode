import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ServerMessage, SessionSummary } from '@voicecode/protocol';
import { Composer, type ComposerHandle } from '../components/Composer';
import { Deck, type DeckApproval, type DeckStatus } from '../components/Deck';
import { DeckEditor } from '../components/DeckEditor';
import { FolderSheet } from '../components/FolderSheet';
import { ModelSheet } from '../components/ModelSheet';
import { ChatIcon, DeckPadIcon, GearIcon } from '../components/Icons';
import { PermissionCard } from '../components/PermissionCard';
import { SessionBar, StartSession, useProjectChoice } from '../components/SessionBar';
import { Toasts } from '../components/Toasts';
import { SettingsSheet } from '../components/SettingsSheet';
import { TerminalView, type TerminalMessage } from '../components/TerminalView';
import { Trackpad } from '../components/Trackpad';
import { Transcript, type TranscriptHandle } from '../components/Transcript';
import { UsageSheet } from '../components/UsageSheet';
import { useAgentSocket } from '../hooks/useAgentSocket';
import { useAlertSounds } from '../hooks/useAlertSounds';
import { useApprovalAlerts } from '../hooks/useApprovalAlerts';
import { useDeck, type Macro } from '../hooks/useDeck';
import { useMicStream, type MicStream } from '../hooks/useMicStream';
import { speechRecognitionSupported } from '../hooks/useSpeechRecognition';
import { useSpeakReplies } from '../hooks/useSpeakReplies';
import { useSettings } from '../hooks/useSettings';
import { useUsage } from '../hooks/useUsage';
import { useWakeLock } from '../hooks/useWakeLock';
import { initialState, reducer, type Toast } from '../lib/store';

type Tab = 'claude' | 'trackpad';

const CONNECTION_LABEL = {
  connecting: 'Connecting',
  open: 'Connected',
  reconnecting: 'Reconnecting',
  unpaired: 'Not paired',
} as const;

/** The dictation state in words, for the terminal button's label (screen readers, long press). */
function voiceText(session: SessionSummary): string {
  const voice = session.voice;
  if (session.attached && session.state === 'awaiting_permission') {
    return 'It is asking something in the terminal; answer with the keys below.';
  }
  switch (voice?.state) {
    case 'idle':
      return session.attached
        ? 'Hold the mic to dictate into your terminal.'
        : 'Hold the mic to dictate through Claude Code.';
    case 'starting':
      return 'Starting to record…';
    case 'recording':
      return 'Recording… release to send.';
    case 'finalizing':
      return 'Sending…';
    case 'error':
      return voice.detail ?? 'Dictation failed.';
    default:
      return 'Dictation is not on yet. If it stays off, open the terminal and run /voice tap.';
  }
}

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
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const deckMode = settings.claudeLayout === 'deck';
  /** The deck has the screen: the conversation is hidden, approvals still show. */
  const deckFull = deckMode && !settings.deckHistory;

  // Terminal bytes go straight to the open terminal view, not through the reducer.
  const terminalListeners = useRef(new Set<(message: TerminalMessage) => void>());
  const onMessage = useCallback((message: ServerMessage) => {
    if (
      message.type === 'terminal.snapshot' ||
      message.type === 'terminal.data' ||
      message.type === 'terminal.exit'
    ) {
      for (const listener of terminalListeners.current) listener(message);
      return;
    }
    dispatch({ type: 'server', message });
  }, []);
  const subscribeTerminal = useCallback((listener: (message: TerminalMessage) => void) => {
    terminalListeners.current.add(listener);
    return () => {
      terminalListeners.current.delete(listener);
    };
  }, []);
  const { state: connection, send, sendBinary } = useAgentSocket(onMessage);
  // Claude Code dictation: the phone's audio goes to a virtual microphone on the PC.
  const micStream = useMicStream({ send, sendBinary, mic: state.voiceMic });

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

  // A controlled terminal session that waits for an answer shows its screen on its own.
  const attachedWaiting = active?.attached === true && active.state === 'awaiting_permission';
  const showTerminal = terminalOpen || attachedWaiting;

  // In a voice session the agent also presses Claude Code's dictation key for us, so a
  // press is "start recording there + stream the mic" and a release the reverse.
  const voiceSession = active?.kind === 'voice' ? active : undefined;
  const remoteMic: MicStream | undefined =
    settings.dictation === 'claude-code'
      ? {
          ...micStream,
          error:
            micStream.error ??
            (voiceSession?.voice?.state === 'error' ? voiceSession.voice.detail : undefined),
          start: () => {
            if (voiceSession)
              send({ type: 'voice.ptt', sessionId: voiceSession.id, pressed: true });
            micStream.start();
          },
          stop: () => {
            micStream.stop();
            if (voiceSession)
              send({ type: 'voice.ptt', sessionId: voiceSession.id, pressed: false });
          },
        }
      : undefined;

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
  // Taking control keeps the session in the terminal: keys and dictation go to it.
  const controlPc = (target = pc) => {
    if (!target) return;
    if (!target.projectId) {
      const ok = confirm(
        `Allow Claude to work in this folder from your phone?\n\n${target.cwd}\n\nTool calls it asks about in the terminal can be answered from the terminal view.`,
      );
      if (!ok) return;
    }
    send({
      type: 'pc.session.control',
      sessionId: target.sessionId,
      allowFolder: !target.projectId,
    });
  };

  const permissions = useMemo(
    () => Object.values(state.permissions).sort((a, b) => a.createdAt - b.createdAt),
    [state.permissions],
  );
  useApprovalAlerts(permissions, settings.notifyApprovals);
  const activeEvents = useMemo(
    () => (active ? (state.events[active.id] ?? []) : []),
    [active, state.events],
  );
  useAlertSounds({
    enabled: settings.soundAlerts,
    activeSessionId: active?.id,
    activeEvents,
    activeState: active?.state,
    pcSessionId: pcId,
    pcEvents,
    toasts: state.toasts,
    error: state.error,
    dictationError: remoteMic?.error,
  });
  useSpeakReplies(active?.id, activeEvents, settings.speakReplies, settings.voiceLang);
  const activePermissions = permissions.filter((p) => p.sessionId === active?.id);
  const otherPermissions = permissions.length - activePermissions.length;
  const live = active && active.state !== 'closed' && active.state !== 'error';
  useUsage(
    send,
    connection === 'open',
    usageOpen || (tab === 'claude' && deckMode && deck.pad === 'usage'),
    Object.values(state.sessions).some((s) => s.state === 'running'),
  );
  const [startProjectId, setStartProjectId] = useProjectChoice(state.projects, active?.projectId);
  const openFolder = state.roots.length ? () => setFoldersOpen(true) : undefined;
  // With Claude Code dictation chosen and a virtual microphone on the PC, new sessions
  // run Claude Code in a terminal there so its own /voice can be used.
  const voiceSessions = settings.dictation === 'claude-code' && state.voiceMic.status.available;
  const startModel = settings.model || undefined;
  const startEffort = settings.effort || undefined;
  const startSession = (projectId: string) =>
    send(
      voiceSessions
        ? { type: 'voice.session.start', projectId, model: startModel, effort: startEffort }
        : { type: 'claude.session.start', projectId, model: startModel, effort: startEffort },
    );

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
      {state.pcControl.available && state.pcSessions.length > 0 && (
        <div className="pc-offer">
          {state.pcSessions.slice(0, 3).map((p) => (
            <button
              key={p.sessionId}
              className="btn btn-block"
              disabled={connection !== 'open'}
              onClick={() => controlPc(p)}
            >
              Take control of the terminal in {p.folder}
            </button>
          ))}
        </div>
      )}
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
        Press a key, or keep Hold to talk pressed while you speak. To change the keys, open Deck
        options (⋯) and choose Customize deck.
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
  const replies = useMemo(
    () =>
      (pcId ? pcEvents : activeEvents).flatMap(({ event }) =>
        event.kind === 'assistant_text' && event.text.trim() ? [event.text] : [],
      ),
    [pcId, pcEvents, activeEvents],
  );
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
  // The deck answers the request it showed, by id: never whichever happens to be first now.
  const respond = (decision: 'allow' | 'deny', requestId: string) => {
    const request = activePermissions.find((p) => p.requestId === requestId);
    if (!request) return;
    send({
      type: 'claude.permission.respond',
      sessionId: request.sessionId,
      requestId: request.requestId,
      decision,
      rememberForSession: false,
    });
  };
  const deckApproval: DeckApproval | undefined = approval && {
    requestId: approval.requestId,
    toolName: approval.toolName,
    detail: approval.detail,
    complete: approval.complete,
    position: 1,
    total: activePermissions.length,
  };
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
  const claudeClass = [
    'claude',
    deckMode && 'claude-deck',
    deckFull && 'claude-deck-full',
    deckMode && activePermissions.length > 0 && 'claude-deck-approval',
  ]
    .filter(Boolean)
    .join(' ');

  const banners = (
    <>
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
    </>
  );
  /**
   * With the deck, banners sit at the top of the conversation column: above the whole
   * tab they pushed the deck down, and in landscape its bottom row off the screen.
   */
  const bannersInColumn = tab === 'claude' && deckMode;

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

      {!bannersInColumn && banners}

      {tab === 'claude' ? (
        <main className={claudeClass}>
          <div className="claude-column">
            {bannersInColumn && banners}
            <SessionBar
              disabled={connection !== 'open'}
              state={state}
              send={send}
              sheetOpen={sessionsOpen}
              onSheetOpenChange={setSessionsOpen}
              onSelect={openSession}
              onSelectPc={openPcSession}
              onOpenFolder={openFolder}
              start={{ voice: voiceSessions, model: settings.model, effort: settings.effort }}
              onOpenModel={() => setModelOpen(true)}
              status={
                deckStatus === 'done'
                  ? { label: 'Done', chip: 'idle' }
                  : deckStatus === 'error'
                    ? { label: 'Error', chip: 'error' }
                    : undefined
              }
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
                {activePermissions.map((request, i) => (
                  <PermissionCard
                    key={request.requestId}
                    request={request}
                    send={send}
                    disabled={connection !== 'open'}
                    onDeck={deckMode}
                    queued={i > 0}
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
                        {state.pcControl.available
                          ? 'Take control to dictate and type into it, or continue a copy here.'
                          : pc.status === 'working' || pc.status === 'waiting'
                            ? 'You can continue it here once it finishes.'
                            : 'Continue it here as a copy; the terminal keeps its own.'}
                      </span>
                    </p>
                    <div className="pc-bar-actions">
                      {state.pcControl.available && (
                        <button
                          className="btn btn-primary"
                          disabled={connection !== 'open'}
                          onClick={() => controlPc()}
                        >
                          Take control
                        </button>
                      )}
                      <button
                        className={state.pcControl.available ? 'btn' : 'btn btn-primary'}
                        disabled={
                          connection !== 'open' ||
                          pc.status === 'working' ||
                          pc.status === 'waiting'
                        }
                        onClick={continuePc}
                      >
                        {state.pcControl.available ? 'Continue as copy' : 'Continue on phone'}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="pc-bar-text muted">This session has ended on the PC.</p>
                )}
              </div>
            )}
            {voiceSession && live && (
              // One small floating toggle instead of a banner: errors already show under
              // the input, and the terminal opens by itself when Claude asks something.
              <div className="terminal-toggle-anchor">
                <button
                  className="terminal-toggle"
                  aria-expanded={showTerminal}
                  aria-label={`${showTerminal ? 'Hide' : 'Show'} terminal. ${voiceText(voiceSession)}`}
                  title={voiceText(voiceSession)}
                  onClick={() => setTerminalOpen(!showTerminal)}
                >
                  <span
                    className={`terminal-dot terminal-dot-${
                      voiceSession.state === 'awaiting_permission'
                        ? 'waiting'
                        : (voiceSession.voice?.state ?? 'off')
                    }`}
                    aria-hidden
                  />
                  {showTerminal ? 'Hide' : 'Terminal'}
                </button>
              </div>
            )}
            {voiceSession && live && showTerminal && (
              <TerminalView sessionId={voiceSession.id} send={send} subscribe={subscribeTerminal} />
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
                remoteMic={remoteMic}
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
              approval={deckApproval}
              micSupported={remoteMic ? remoteMic.supported : speechRecognitionSupported()}
              listening={canPrompt && listening}
              full={deckFull}
              replies={replies}
              usage={state.usage}
              onPadChange={(pad) => saveDeck({ ...deck, pad })}
              onUsage={() => setUsageOpen(true)}
              onToggleFull={() => updateSettings({ deckHistory: !settings.deckHistory })}
              onMacro={runMacro}
              onAccept={(id) => respond('allow', id)}
              onReject={(id) => respond('deny', id)}
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

      {usageOpen && (
        <UsageSheet
          usage={state.usage}
          send={send}
          disabled={connection !== 'open'}
          onClose={() => setUsageOpen(false)}
        />
      )}

      {modelOpen && (
        <ModelSheet
          state={state}
          send={send}
          session={active}
          chosen={settings.model}
          onChoose={(model) => updateSettings({ model })}
          effort={settings.effort}
          onChooseEffort={(effort) => updateSettings({ effort })}
          disabled={connection !== 'open'}
          onClose={() => setModelOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsSheet
          settings={settings}
          update={updateSettings}
          device={state.device}
          agentVersion={state.agent?.version}
          voiceMic={state.voiceMic.status}
          storage={state.storage}
          send={send}
          connected={connection === 'open'}
          onClose={() => setSettingsOpen(false)}
          onUnpaired={onUnpaired}
        />
      )}
    </div>
  );
}
