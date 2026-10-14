import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { EventItem } from '../lib/store';
import { ArrowDownIcon } from './Icons';
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

/** Within this many pixels of the end counts as "reading the latest output". */
const STICK_PX = 96;

interface Props {
  events: EventItem[];
  streaming: string;
  /** Shown instead of the transcript when there is nothing in it yet. */
  empty: ReactNode;
}

/**
 * The session's messages. New output keeps the view pinned to the end only while the
 * reader is already there; someone scrolled up to re-read gets a "Latest" button
 * instead of being yanked down by every streamed word.
 */
export function Transcript({ events, streaming, empty }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true);
  const [behind, setBehind] = useState(false);

  const scrollToEnd = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atEndRef.current = true;
    setBehind(false);
  };

  // Your own new prompt always brings you back to the end; later chunks of the reply
  // respect where you scrolled to.
  const lastItem = events[events.length - 1];
  const promptSeq = lastItem?.event.kind === 'user_prompt' ? lastItem.seq : undefined;
  const seenPromptRef = useRef(promptSeq);
  useLayoutEffect(() => {
    const newPrompt = promptSeq !== undefined && promptSeq !== seenPromptRef.current;
    seenPromptRef.current = promptSeq;
    if (atEndRef.current || newPrompt) scrollToEnd();
    else setBehind(true);
  }, [events.length, streaming, promptSeq]);

  // The keyboard, a growing composer or an approval card shrink the view without a
  // scroll event; stay pinned to the newest output when that happens.
  const hasContent = events.length > 0 || streaming !== '';
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atEndRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasContent]);

  if (!hasContent) {
    return <div className="transcript empty">{empty}</div>;
  }
  return (
    <div className="transcript-wrap">
      <div
        ref={scrollRef}
        className="transcript"
        tabIndex={0}
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
          atEndRef.current = atEnd;
          if (atEnd) setBehind(false);
        }}
      >
        {/* Only finished messages are announced; the streaming bubble would otherwise
            be re-read on every token. */}
        <div className="transcript-log" role="log" aria-relevant="additions">
          {events.map((item) => (
            <EventRow key={item.seq} item={item} />
          ))}
        </div>
        {streaming && (
          <div className="msg msg-assistant streaming" aria-busy="true">
            <Markdown text={streaming} />
          </div>
        )}
      </div>
      {behind && (
        <button className="jump-latest" onClick={() => scrollToEnd(true)}>
          <ArrowDownIcon size={16} /> Latest
        </button>
      )}
    </div>
  );
}
