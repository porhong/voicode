import { useEffect, useState } from 'react';
import type { Send } from '../hooks/useAgentSocket';
import type { AppState } from '../lib/store';
import { Sheet } from './Sheet';

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden>
      <path
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Last path segment, for either separator (the PC may be Windows or Linux). */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Browse the PC's workspace folders and start Claude in any project inside them, with
 * no per-folder setup on the PC. The agent checks every path against the roots;
 * hidden folders are not listed or openable.
 */
export function FolderSheet({
  state,
  send,
  disabled,
  onClose,
}: {
  state: AppState;
  send: Send;
  disabled: boolean;
  onClose: () => void;
}) {
  // The folder asked for; the listing on screen is for another one until the paths
  // match (the agent answers with the same canonical paths it listed).
  const [want, setWant] = useState<string>();
  const listing = state.folders;
  const loading = !listing || listing.path !== want;

  useEffect(() => {
    if (!disabled) send(want ? { type: 'folders.list', path: want } : { type: 'folders.list' });
  }, [want, disabled, send]);

  const current = loading ? undefined : listing;
  const here = current?.path;

  return (
    <Sheet title="Open a folder" onClose={onClose}>
      <div className="folder-nav">
        {(here || want) && (
          <button
            className="btn btn-small btn-ghost"
            onClick={() => setWant(current?.parent)}
            aria-label={current?.parent ? 'Up one folder' : 'All workspace folders'}
          >
            ← {current?.parent ? baseName(current.parent) : 'Workspace'}
          </button>
        )}
        <span className="folder-path small muted" title={here}>
          {here ? baseName(here) : 'Workspace folders on the PC'}
        </span>
      </div>

      <ul className="list folder-list">
        {loading && <li className="small muted list-note">Loading…</li>}
        {current?.entries.length === 0 && (
          <li className="small muted list-note">
            {here ? 'No subfolders here.' : 'The workspace folders no longer exist on the PC.'}
          </li>
        )}
        {current?.entries.map((entry) => (
          <li key={entry.path} className="list-row">
            <button className="list-main folder-entry" onClick={() => setWant(entry.path)}>
              <FolderIcon />
              <span className="list-title">{here ? entry.name : entry.path}</span>
              {entry.isRepo && <span className="chip">git</span>}
              {entry.isProject && <span className="chip chip-idle">allowed</span>}
            </button>
          </li>
        ))}
        {current?.truncated && (
          <li className="small muted list-note">Some folders are not shown (too many).</li>
        )}
      </ul>

      <div className="folder-actions">
        <button
          className="btn btn-primary btn-block"
          disabled={disabled || !here}
          onClick={() => {
            if (!here) return;
            send({ type: 'claude.folder.start', path: here });
            onClose();
          }}
        >
          {here ? `Start Claude in ${baseName(here)}` : 'Pick a folder'}
        </button>
        <p className="small muted">
          Every tool call still needs your approval here. Opening a folder adds it to the PC’s
          allowed projects.
        </p>
      </div>
    </Sheet>
  );
}
