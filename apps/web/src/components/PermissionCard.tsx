import { useState } from 'react';
import type { PermissionRequest } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';

/**
 * Approval prompt for a pending Claude tool call. Approvals are tap-only by design:
 * a misheard voice command must never run a shell command.
 */
export function PermissionCard({ request, send }: { request: PermissionRequest; send: Send }) {
  const [feedback, setFeedback] = useState('');
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
    <section className="permission-card" aria-live="assertive">
      <header>
        <span className="badge">{request.toolName}</span>
        <h3>{request.title}</h3>
      </header>
      {request.description && <p className="small muted">{request.description}</p>}
      <pre className="permission-detail">{request.detail}</pre>
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
        <button className="btn btn-danger" onClick={() => respond('deny')}>
          Reject
        </button>
        <button className="btn btn-primary" onClick={() => respond('allow')}>
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
          <button className="link" onClick={() => respond('allow', true)}>
            Always allow this session
          </button>
        )}
      </div>
    </section>
  );
}
