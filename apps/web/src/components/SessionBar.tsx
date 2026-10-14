import { useEffect, useState } from 'react';
import type { ProjectInfo, SessionSummary } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import type { AppState } from '../lib/store';
import { ChevronDownIcon, PlusIcon } from './Icons';
import { Sheet } from './Sheet';

export const STATE_LABEL: Record<SessionSummary['state'], string> = {
  starting: 'Starting',
  idle: 'Ready',
  running: 'Working',
  awaiting_permission: 'Needs approval',
  closed: 'Closed',
  error: 'Error',
};

function projectName(projects: ProjectInfo[], id: string): string {
  return projects.find((p) => p.id === id)?.name ?? 'Project';
}

interface Props {
  /** True while the connection to the agent is not open; actions would be lost. */
  disabled?: boolean;
  state: AppState;
  send: Send;
  onSelect: (sessionId: string) => void;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
}

/**
 * One compact row (current session, its state, and "new session") so the transcript
 * keeps most of a phone screen; switching, resuming and closing live in a sheet.
 */
export function SessionBar({
  state,
  send,
  onSelect,
  disabled = false,
  sheetOpen,
  onSheetOpenChange,
}: Props) {
  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined;

  if (!state.projects.length) {
    return (
      <div className="session-header">
        <p className="small muted session-empty">
          No projects are allowed yet. On the PC run{' '}
          <code>voicecode-agent projects add &lt;dir&gt;</code>.
        </p>
      </div>
    );
  }

  // With no session open, "+" opens the sheet so the project is chosen explicitly.
  const newSessionProject = active?.projectId;
  const sessionLabel = active
    ? `${projectName(state.projects, active.projectId)}, ${active.title ?? 'New session'}`
    : 'no session';

  return (
    <>
      <div className="session-header">
        <button
          className="session-switch"
          onClick={() => onSheetOpenChange(true)}
          aria-haspopup="dialog"
          aria-label={`Sessions: ${sessionLabel}`}
        >
          <span className="session-switch-text">
            <span className="session-project">
              {active ? projectName(state.projects, active.projectId) : 'No session'}
            </span>
            <span className="session-title">
              {active ? (active.title ?? 'New session') : 'Tap to start or resume'}
            </span>
          </span>
          <ChevronDownIcon />
        </button>
        {active && (
          <span className={`chip chip-${active.state}`} role="status">
            {STATE_LABEL[active.state]}
          </span>
        )}
        <button
          className="icon-button icon-button-filled"
          disabled={disabled}
          onClick={() =>
            newSessionProject
              ? send({ type: 'claude.session.start', projectId: newSessionProject })
              : onSheetOpenChange(true)
          }
          aria-label={
            newSessionProject
              ? `New session in ${projectName(state.projects, newSessionProject)}`
              : 'New session'
          }
        >
          <PlusIcon />
        </button>
      </div>
      {sheetOpen && (
        <SessionSheet
          state={state}
          send={send}
          disabled={disabled}
          onSelect={(id) => {
            onSelect(id);
            onSheetOpenChange(false);
          }}
          onClose={() => onSheetOpenChange(false)}
        />
      )}
    </>
  );
}

function SessionSheet({
  state,
  send,
  disabled,
  onSelect,
  onClose,
}: {
  state: AppState;
  send: Send;
  disabled: boolean;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}) {
  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : undefined;
  const [projectId, setProjectId] = useProjectChoice(state.projects, active?.projectId);
  const live = Object.values(state.sessions).filter((s) => s.state !== 'closed');
  const history = state.history[projectId];

  // Earlier sessions of the chosen project, fetched whenever it changes.
  useEffect(() => {
    if (projectId && !disabled) send({ type: 'claude.sessions.history', projectId });
  }, [projectId, disabled, send]);

  return (
    <Sheet title="Sessions" onClose={onClose}>
      <StartSession
        projects={state.projects}
        projectId={projectId}
        onProjectChange={setProjectId}
        disabled={disabled}
        onStart={() => {
          send({ type: 'claude.session.start', projectId });
          onClose();
        }}
      />

      {live.length > 0 && (
        <>
          <h3>Open sessions</h3>
          <ul className="list">
            {live.map((s) => (
              <li key={s.id} className={s.id === active?.id ? 'list-row current' : 'list-row'}>
                <button className="list-main" onClick={() => onSelect(s.id)}>
                  <span className="list-title">{s.title ?? 'New session'}</span>
                  <span className="small muted">
                    {projectName(state.projects, s.projectId)} · {STATE_LABEL[s.state]}
                  </span>
                </button>
                <button
                  className="btn btn-small btn-ghost"
                  disabled={disabled}
                  onClick={() => send({ type: 'claude.session.close', sessionId: s.id })}
                  aria-label={`Close ${s.title ?? 'new session'}`}
                >
                  Close
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Resume in {projectName(state.projects, projectId)}</h3>
      <ul className="list">
        {history === undefined && <li className="small muted list-note">Loading…</li>}
        {history?.length === 0 && (
          <li className="small muted list-note">No earlier sessions for this project.</li>
        )}
        {history?.map((h) => (
          <li key={h.claudeSessionId} className="list-row">
            <button
              className="list-main"
              disabled={disabled}
              onClick={() => {
                send({ type: 'claude.session.start', projectId, resume: h.claudeSessionId });
                onClose();
              }}
            >
              <span className="list-title">{h.summary}</span>
              <span className="small muted">
                {new Date(h.lastModified).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                {h.gitBranch ? ` · ${h.gitBranch}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/**
 * The chosen project, falling back to the first one: the project list arrives after
 * mount and can change at runtime, so the choice is derived rather than frozen.
 */
export function useProjectChoice(projects: ProjectInfo[], preferred?: string) {
  const [chosen, setChosen] = useState(preferred);
  const projectId = projects.some((p) => p.id === chosen) ? chosen! : (projects[0]?.id ?? '');
  return [projectId, setChosen] as const;
}

/** Project picker (only when there is a choice) plus the "New session" button. */
export function StartSession({
  projects,
  projectId,
  onProjectChange,
  onStart,
  disabled,
}: {
  projects: ProjectInfo[];
  projectId: string;
  onProjectChange: (id: string) => void;
  onStart: () => void;
  disabled: boolean;
}) {
  return (
    <div className="start-session">
      {projects.length > 1 && (
        <label className="field">
          <span className="small muted">Project</span>
          <select
            className="select"
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="btn btn-primary btn-block" disabled={disabled} onClick={onStart}>
        <PlusIcon size={20} /> New session
        {projects.length === 1 ? ` in ${projects[0]!.name}` : ''}
      </button>
    </div>
  );
}
