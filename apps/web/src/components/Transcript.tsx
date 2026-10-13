import { useEffect, useRef } from 'react';
import type { EventItem } from '../lib/store';
import { Markdown } from './Markdown';

function formatCost(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

function EventRow({ item }: { item: EventItem }) {
  const e = item.event;
  switch (e.kind) {
    case 'user_prompt':
      return (
        <div className="msg msg-user">
          <div className="msg-meta">{e.deviceName}</div>
          {e.text}
        </div>
      );
    case 'assistant_text':
      return (
        <div className="msg msg-assistant">
          <Markdown text={e.text} />
        </div>
      );
    case 'thinking':
      return <div className="msg msg-thinking">{e.text}</div>;
    case 'tool_use':
      return (
        <div className="tool-line">
          <span className="tool-dot" aria-hidden /> {e.summary}
        </div>
      );
    case 'tool_result':
      return e.isError ? (
        <div className="tool-line tool-error">↳ {e.summary || 'failed'}</div>
      ) : null;
    case 'result':
      return (
        <div className="turn-end">
          {e.isError ? 'Stopped' : 'Done'} · {(e.durationMs / 1000).toFixed(1)}s ·{' '}
          {formatCost(e.totalCostUsd)} total
        </div>
      );
    case 'status':
      return <div className="turn-end">{e.message}</div>;
    case 'error':
      return <div className="msg msg-error">{e.message}</div>;
  }
}

export function Transcript({ events, streaming }: { events: EventItem[]; streaming: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [events.length, streaming]);

  if (!events.length && !streaming) {
    return (
      <div className="transcript empty">
        <p className="muted">Tap the microphone and tell Claude what to do.</p>
      </div>
    );
  }
  return (
    <div className="transcript" aria-live="polite">
      {events.map((item) => (
        <EventRow key={item.seq} item={item} />
      ))}
      {streaming && (
        <div className="msg msg-assistant streaming">
          <Markdown text={streaming} />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
