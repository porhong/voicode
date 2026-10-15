import { useEffect, useState } from 'react';
import type { UsageReport } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';
import { LEVEL_TEXT, percentText, planName, resetText, usageLevel } from '../lib/usage';
import { Sheet } from './Sheet';

interface Props {
  usage?: UsageReport;
  send: Send;
  disabled: boolean;
  onClose: () => void;
}

function updatedText(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Every usage limit of the Claude plan, as `/usage` in Claude Code shows them: one row
 * per limit with a meter, how much is used and when it starts over. Bars rather than
 * rings here: in a list, lengths are easier to compare than angles.
 */
export function UsageSheet({ usage, send, disabled, onClose }: Props) {
  /** The answer a refresh is waiting to replace. */
  const [refreshing, setRefreshing] = useState<number | undefined>();
  const pending = refreshing !== undefined && usage?.fetchedAt === refreshing;

  useEffect(() => {
    if (!disabled) send({ type: 'claude.usage' });
  }, [send, disabled]);

  const refresh = () => {
    setRefreshing(usage?.fetchedAt ?? 0);
    send({ type: 'claude.usage', refresh: true });
  };

  return (
    <Sheet title="Usage limits" onClose={onClose}>
      {!usage ? (
        <p className="small muted">Asking Claude Code on the PC…</p>
      ) : !usage.available ? (
        <p className="small muted">
          Claude Code on the PC is signed in with an API key or a cloud provider, so plan limits
          don’t apply. Usage is billed per token instead.
        </p>
      ) : (
        <>
          <p className="small muted">
            {planName(usage.plan)}. Limits are shared by Claude Code, claude.ai and the Claude apps
            on your account.
          </p>
          <ul className="usage-list">
            {usage.limits.map((limit) => {
              const level = usageLevel(limit.utilization);
              const reset = resetText(limit);
              return (
                <li key={limit.id} className="usage-row" data-level={level}>
                  <div className="usage-row-head">
                    <span className="usage-row-name">{limit.label}</span>
                    <span className="usage-row-pct">{percentText(limit.utilization)}</span>
                  </div>
                  <div
                    className="usage-meter"
                    role="meter"
                    aria-label={limit.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={limit.utilization ?? undefined}
                    aria-valuetext={`${percentText(limit.utilization)} used${LEVEL_TEXT[level] ? `, ${LEVEL_TEXT[level].toLowerCase()}` : ''}`}
                  >
                    <span style={{ width: `${limit.utilization ?? 0}%` }} />
                  </div>
                  <span className="small muted">
                    {[LEVEL_TEXT[level], reset].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            })}
            {!usage.limits.length && (
              <li className="small muted">Claude Code reported no limits for this plan.</li>
            )}
          </ul>
        </>
      )}
      {usage?.error && <p className="small error-text">{usage.error}</p>}
      <div className="usage-foot">
        <span className="small muted" aria-live="polite">
          {pending ? 'Refreshing…' : usage ? updatedText(usage.fetchedAt) : ''}
        </span>
        <button className="btn btn-small" disabled={disabled || pending} onClick={refresh}>
          Refresh
        </button>
      </div>
    </Sheet>
  );
}
