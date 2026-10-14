import { useEffect } from 'react';
import type { SessionSummary } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import type { AppState } from '../lib/store';
import { modelLabel } from '../lib/models';
import { Sheet } from './Sheet';

interface Props {
  state: AppState;
  send: Send;
  /** The session on screen; its model is switched right away. */
  session?: SessionSummary;
  /** This phone's choice for new sessions ('' = the PC's default). */
  chosen: string;
  onChoose: (model: string) => void;
  disabled: boolean;
  onClose: () => void;
}

/**
 * Picks the Claude model: for the session on screen now, and for the sessions this phone
 * starts next. The list comes from the agent (the SDK's own list for SDK sessions, the
 * aliases Claude Code accepts for terminal sessions).
 */
export function ModelSheet({ state, send, session, chosen, onChoose, disabled, onClose }: Props) {
  const live = session && session.state !== 'closed' && session.state !== 'error';
  const sessionId = live ? session.id : undefined;
  useEffect(() => {
    if (!disabled) send({ type: 'claude.models', sessionId });
  }, [send, sessionId, disabled]);
  const offer = state.models && state.models.sessionId === sessionId ? state.models : undefined;
  const busy = session?.state === 'running' || session?.state === 'awaiting_permission';

  const pick = (value: string) => {
    const model = value === 'default' ? null : value;
    if (sessionId) send({ type: 'claude.model.set', sessionId, model });
    onChoose(model ?? '');
    onClose();
  };
  const isChosen = (value: string) => (value === 'default' ? chosen === '' : chosen === value);

  return (
    <Sheet title="Model" onClose={onClose}>
      <p className="small muted">
        {sessionId
          ? `This session uses ${modelLabel(session?.model) ?? 'the PC’s default'}. Your choice applies to it now and to new sessions from this phone.`
          : 'Applies to the sessions you start from this phone.'}
      </p>
      {offer?.persistsDefault && (
        <p className="small muted">
          Claude Code in the terminal also saves it as its default for new sessions on the PC.
        </p>
      )}
      {busy && session?.kind === 'voice' && (
        <p className="small error-text">Claude is working; switch once it has finished.</p>
      )}
      <ul className="list">
        {!offer && <li className="small muted list-note">Loading…</li>}
        {offer?.models.map((m) => (
          <li key={m.value} className={isChosen(m.value) ? 'list-row current' : 'list-row'}>
            <button
              className="list-main"
              disabled={disabled || (busy && session?.kind === 'voice')}
              onClick={() => pick(m.value)}
            >
              <span className="list-title">{m.label}</span>
              {m.description && <span className="small muted">{m.description}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
