import { useState } from 'react';
import type { SessionSummary } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import type { AppState } from '../lib/store';

const STATE_LABEL: Record<SessionSummary['state'], string> = {
  starting: 'Starting',
  idle: 'Ready',
  running: 'Working',
  awaiting_permission: 'Needs approval',
  closed: 'Closed',
  error: 'Error',
};

interface Props {
  state: AppState;
  send: Send;
  onSelect: (sessionId: string) => void;
}

/** Project/session picker: start a new session, resume an earlier one, or switch. */
export function SessionBar({ state, send, onSelect }: Props) {
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? '');
  const [showResume, setShowResume] = useState(false);
  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined;
  const live = Object.values(state.sessions).filter((s) => s.state !== 'closed');
  const history = state.history[projectId] ?? [];

  if (!state.projects.length) {
    return (
      <div className="session-bar">
        <p className="small muted">
          No projects are allowed yet. On the PC run{' '}
          <code>voicecode-agent projects add &lt;dir&gt;</code> and restart.
        </p>
      </div>
    );
  }

  return (
    <div className="session-bar">
      <div className="session-row">
        {live.length > 0 ? (
          <select
            className="select"
            value={active?.id ?? ''}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Session"
          >
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {state.projects.find((p) => p.id === s.projectId)?.name ?? 'Project'} —{' '}
                {s.title ?? 'New session'}
              </option>
            ))}
          </select>
        ) : (
          <select
            className="select"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project"
          >
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {active && <span className={`chip chip-${active.state}`}>{STATE_LABEL[active.state]}</span>}
      </div>
      <div className="session-row">
        <button
          className="btn btn-small"
          onClick={() =>
            send({ type: 'claude.session.start', projectId: active?.projectId ?? projectId })
          }
        >
          New session
        </button>
        <button
          className="btn btn-small btn-ghost"
          onClick={() => {
            const pid = active?.projectId ?? projectId;
            setProjectId(pid);
            setShowResume((v) => !v);
            send({ type: 'claude.sessions.history', projectId: pid });
          }}
        >
          Resume…
        </button>
        {active && active.state !== 'closed' && (
          <button
            className="btn btn-small btn-ghost"
            onClick={() => send({ type: 'claude.session.close', sessionId: active.id })}
          >
            Close
          </button>
        )}
      </div>
      {showResume && (
        <ul className="resume-list">
          {history.length === 0 && (
            <li className="small muted">No earlier sessions for this project.</li>
          )}
          {history.map((h) => (
            <li key={h.claudeSessionId}>
              <button
                className="resume-item"
                onClick={() => {
                  setShowResume(false);
                  send({ type: 'claude.session.start', projectId, resume: h.claudeSessionId });
                }}
              >
                <span>{h.summary}</span>
                <span className="small muted">
                  {new Date(h.lastModified).toLocaleString()}
                  {h.gitBranch ? ` · ${h.gitBranch}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
