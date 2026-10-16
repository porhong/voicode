import { useEffect, useId, useState } from 'react';
import type { SessionQuestion } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';

/**
 * A menu Claude Code shows in the terminal (folder trust, its own permission prompt, a
 * question), with a button per option. The agent read it off the terminal screen, so
 * the card shows what the terminal shows; the answer goes back with the option's text
 * and is only applied if that same menu is still open.
 */
export function QuestionCard({
  sessionId,
  question,
  send,
  disabled = false,
  onShowTerminal,
}: {
  sessionId: string;
  question: SessionQuestion;
  send: Send;
  disabled?: boolean;
  /** Opens the terminal view, for what the card can't show (the whole screen). */
  onShowTerminal?: () => void;
}) {
  const titleId = useId();
  /** The option just picked, for this menu only, until the agent has had time to act. */
  const key = `${question.text}\n${question.options.join('\n')}`;
  const [pick, setPick] = useState<{ key: string; index: number } | undefined>();
  const picked = pick?.key === key ? pick.index : undefined;
  useEffect(() => {
    if (!pick) return;
    const timer = window.setTimeout(() => setPick(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [pick]);

  return (
    <section
      className="permission-card question-card"
      aria-live="assertive"
      aria-labelledby={titleId}
    >
      <header>
        <span className="badge">Claude Code</span>
        <h3 id={titleId}>{question.text}</h3>
      </header>
      {question.detail && question.detail.length > 0 && (
        <pre className="permission-detail" tabIndex={0} aria-label="What the terminal shows">
          {question.detail.join('\n')}
        </pre>
      )}
      <div className="question-options" role="group" aria-labelledby={titleId}>
        {question.options.map((option, index) => (
          <button
            key={`${index}-${option}`}
            className="btn btn-block question-option"
            disabled={disabled || picked !== undefined}
            aria-busy={picked === index}
            onClick={() => {
              setPick({ key, index });
              send({ type: 'claude.question.answer', sessionId, index, option });
            }}
          >
            {option}
          </button>
        ))}
      </div>
      {onShowTerminal && (
        <button className="link question-terminal" onClick={onShowTerminal}>
          Open the terminal
        </button>
      )}
    </section>
  );
}
