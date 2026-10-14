import { useId, useState } from 'react';
import type { PermissionRequest } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';

/**
 * Approval prompt for a pending Claude tool call. Approvals are tap-only by design:
 * a misheard voice command must never run a shell command.
 */
export function PermissionCard({
  request,
  send,
  disabled = false,
}: {
  request: PermissionRequest;
  send: Send;
  /** True while disconnected: an answer could not reach the agent. */
  disabled?: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const titleId = useId();
  const [showFeedback, setShowFeedback] = useState(false);

  const respond = (decision: 'allow' | 'deny', rememberForSession = false) =>
    send({
      type: 'claude.permission.respond',
      sessionId: request.sessionId,
      requestId: request.requestId,
      decision,
      rememberForSession,
      message: decision === 'deny' && feedback.trim() ? feedback.trim() : undefined,
    });

  return (
    <section className="permission-card" aria-live="assertive" aria-labelledby={titleId}>
      <header>
        <span className="badge">{request.toolName}</span>
        <h3 id={titleId}>{request.title}</h3>
      </header>
      {request.description && <p className="small muted">{request.description}</p>}
      {/* Focusable so the full input can be scrolled with a keyboard too. */}
      <pre className="permission-detail" tabIndex={0} aria-label="Full tool input">
        {request.detail}
      </pre>
      {!request.complete && (
        <p className="small error-text">
          This is too long to review here in full, so it can only be rejected. Ask Claude to split
          it up, or review it on the computer.
        </p>
      )}
      {showFeedback && (
        <textarea
          className="input"
          rows={2}
          placeholder="Tell Claude what to do instead (optional)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      )}
      <div className="permission-actions">
        <button className="btn btn-danger" disabled={disabled} onClick={() => respond('deny')}>
          Reject
        </button>
        <button
          className="btn btn-primary"
          disabled={disabled || !request.complete}
          onClick={() => respond('allow')}
        >
          Accept
        </button>
      </div>
      <div className="permission-secondary">
        {!showFeedback && (
          <button className="link" onClick={() => setShowFeedback(true)}>
            Reject with feedback
          </button>
        )}
        {request.canRemember && (
          <button className="link" disabled={disabled} onClick={() => respond('allow', true)}>
            {request.rememberLabel ?? 'Always allow this session'}
          </button>
        )}
      </div>
    </section>
  );
}
