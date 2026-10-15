import { useEffect, useId, useState } from 'react';
import type { PermissionRequest } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import { useHoldToConfirm } from '../hooks/useHoldToConfirm';

/**
 * Approval prompt for a pending Claude tool call. Approvals are tap-only by design:
 * a misheard voice command must never run a shell command.
 *
 * With `onDeck` (the deck layout) the card is the evidence and the deck is where the
 * answer is given: no Accept or Reject here, so there is one primary control for one
 * decision. The card keeps "Reject with feedback" (a reject is always safe) and the held
 * "Always allow", which the deck has no key for.
 */
export function PermissionCard({
  request,
  send,
  disabled = false,
  onDeck = false,
  queued = false,
}: {
  request: PermissionRequest;
  send: Send;
  /** True while disconnected: an answer could not reach the agent. */
  disabled?: boolean;
  /** The deck answers this approval: the card is for review. */
  onDeck?: boolean;
  /** Another approval in this session is ahead of it on the deck. */
  queued?: boolean;
}) {
  const [feedback, setFeedback] = useState('');
  const titleId = useId();
  const [showFeedback, setShowFeedback] = useState(false);
  /** Released before the hold finished: the note says so for a moment. */
  const [early, setEarly] = useState(false);
  const canAllow = !disabled && request.complete;

  useEffect(() => {
    if (!early) return;
    const timer = window.setTimeout(() => setEarly(false), 1800);
    return () => window.clearTimeout(timer);
  }, [early]);

  const remember = useHoldToConfirm({
    requestId: request.requestId,
    disabled: !onDeck || !canAllow || !request.canRemember,
    onConfirm: () => respond('allow', true),
    onEarly: () => setEarly(true),
  });

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
      {onDeck ? (
        <>
          {/* Review only: the deck below is the one place to answer, one approval at a time. */}
          {request.complete && (
            <p className="permission-deck-note">
              {queued
                ? 'Next on the deck, once the one above is answered.'
                : 'Answer on the deck: hold Accept, or tap Reject.'}
            </p>
          )}
          {showFeedback && (
            <button className="btn btn-danger" disabled={disabled} onClick={() => respond('deny')}>
              Reject with this feedback
            </button>
          )}
        </>
      ) : (
        <div className="permission-actions">
          <button className="btn btn-danger" disabled={disabled} onClick={() => respond('deny')}>
            Reject
          </button>
          <button className="btn btn-primary" disabled={!canAllow} onClick={() => respond('allow')}>
            Accept
          </button>
        </div>
      )}
      {/* Answers a quick tap on the held "Always allow". */}
      {onDeck && early && (
        <p className="permission-hold-note" role="status">
          Too quick: keep holding until it fills
        </p>
      )}
      <div className="permission-secondary">
        {!showFeedback && (
          <button className="link" onClick={() => setShowFeedback(true)}>
            Reject with feedback
          </button>
        )}
        {request.canRemember &&
          (onDeck ? (
            <button
              className={`link btn-hold btn-hold-link ${remember.holding ? 'holding' : ''}`}
              disabled={!canAllow}
              aria-label={`Hold to ${(request.rememberLabel ?? 'Always allow this session').toLowerCase()}`}
              {...remember.handlers}
            >
              <span className="btn-hold-fill" aria-hidden />
              {request.rememberLabel ?? 'Always allow this session'}
            </button>
          ) : (
            <button className="link" disabled={!canAllow} onClick={() => respond('allow', true)}>
              {request.rememberLabel ?? 'Always allow this session'}
            </button>
          ))}
      </div>
    </section>
  );
}
