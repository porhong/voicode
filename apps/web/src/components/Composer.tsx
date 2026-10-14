import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { LIMITS } from '@voicecode/protocol';
import type { MicStream } from '../hooks/useMicStream';
import { stopSpeaking } from '../hooks/useSpeakReplies';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { Settings } from '../hooks/useSettings';
import { MicIcon, SendIcon, StopIcon } from './Icons';

export interface ComposerHandle {
  /** Replaces the draft (e.g. with a suggested prompt) and focuses the input. */
  setDraft: (text: string) => void;
  /** Hold-to-talk from the deck's mic key: start on press, stop and send on release. */
  pushToTalk: (pressed: boolean) => void;
  /** Shows the input row (deck layout) and focuses it for typing. */
  focus: () => void;
}

interface Props {
  ref?: Ref<ComposerHandle>;
  disabled: boolean;
  /** What Claude is doing in this session, if anything. */
  activity?: 'running' | 'awaiting_permission';
  /** An approval card is on screen: the input row steps aside to give it the room. */
  approvalShown: boolean;
  settings: Settings;
  /** Deck layout: the input row stays out of the way until there is something in it. */
  compact?: boolean;
  /**
   * Set when dictation goes to Claude Code on the PC: speech is streamed there instead
   * of being recognised here, so nothing lands in the box and nothing is auto-sent.
   */
  remoteMic?: MicStream;
  /** Reports dictation starting and stopping (the deck lights its mic key). */
  onListeningChange?: (listening: boolean) => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

/** A physical keyboard is likely: Enter sends there, while on phones it adds a line. */
const finePointer = () => window.matchMedia?.('(pointer: fine)').matches ?? false;

/**
 * Prompt input with dictation. One round button does the obvious next thing: dictate
 * when the box is empty, send when it has text, stop while listening. Speech lands in
 * the box so it can be reviewed before sending (unless auto-send is on).
 */
export function Composer({
  ref,
  disabled,
  activity,
  approvalShown,
  settings,
  compact = false,
  remoteMic,
  onListeningChange,
  onSend,
  onInterrupt,
}: Props) {
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  // Mirrors `text` for callbacks that fire outside React's render cycle (speech events).
  const textRef = useRef('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const updateText = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  const submit = (value = textRef.current) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed.slice(0, LIMITS.maxPromptLength));
    updateText('');
  };

  const suppressAutoSendRef = useRef(false);
  const pushToTalkRef = useRef(false);
  const speech = useSpeechRecognition({
    lang: settings.voiceLang,
    onFinal: (phrase) => {
      const prev = textRef.current;
      updateText(prev ? `${prev} ${phrase}` : phrase);
    },
    onEnd: () => {
      const send = settings.autoSendVoice || pushToTalkRef.current;
      if (send && !suppressAutoSendRef.current) submit();
      suppressAutoSendRef.current = false;
      pushToTalkRef.current = false;
    },
  });

  // Either the browser's recognizer or the stream to the PC, with one shape for the UI.
  const dictation = remoteMic
    ? {
        remote: true,
        supported: remoteMic.supported,
        listening: remoteMic.active,
        interim: '',
        error: remoteMic.error,
        start: remoteMic.start,
        stop: remoteMic.stop,
      }
    : { remote: false, ...speech };

  // The input row (and its stop button) is hidden while an approval is shown, so a
  // running dictation is stopped rather than left listening with no way to end it.
  // Its text stays in the box for review instead of being auto-sent.
  const { listening, stop } = dictation;
  useEffect(() => {
    if (approvalShown && listening) {
      suppressAutoSendRef.current = true;
      stop();
    }
  }, [approvalShown, listening, stop]);

  useEffect(() => onListeningChange?.(listening), [listening, onListeningChange]);

  const preview = dictation.interim ? `${text}${text ? ' ' : ''}${dictation.interim}` : text;

  // Grow with the content up to the CSS max-height, then scroll inside. Skipped while
  // the row is hidden (it would measure 0) and redone when it is shown again.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || el.offsetParent === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [preview, approvalShown, typing]);

  const hasText = text.trim().length > 0;
  const rowHidden = approvalShown || (compact && !typing && !hasText && !dictation.listening);
  const action: 'stop-dictation' | 'send' | 'dictate' = dictation.listening
    ? 'stop-dictation'
    : hasText || !dictation.supported
      ? 'send'
      : 'dictate';

  const dictate = () => {
    // Don't let a reply being read aloud leak into the microphone.
    stopSpeaking();
    navigator.vibrate?.(10);
    dictation.start();
  };

  useImperativeHandle(ref, () => ({
    setDraft: (draft: string) => {
      updateText(draft);
      setTyping(true);
      // The row may only just be un-hidden; focus once it is laid out.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    pushToTalk: (pressed: boolean) => {
      if (!dictation.supported || disabled) return;
      if (pressed) {
        if (dictation.listening) return;
        pushToTalkRef.current = !dictation.remote;
        dictate();
      } else {
        dictation.stop();
      }
    },
    focus: () => {
      setTyping(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  }));
  const onAction = () => {
    if (action === 'stop-dictation') return dictation.stop();
    if (action === 'send') return submit();
    dictate();
  };

  return (
    <div
      className={
        rowHidden && (!activity || compact) && !dictation.error
          ? 'composer composer-empty'
          : 'composer'
      }
    >
      {activity && !compact && (
        <div className="working-strip" role="status">
          <span className="working-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span>
            {activity === 'awaiting_permission'
              ? 'Waiting for your approval'
              : 'Claude is working…'}
          </span>
          <button className="btn btn-small btn-ghost" onClick={onInterrupt}>
            <StopIcon size={14} /> Stop
          </button>
        </div>
      )}
      {dictation.error && <p className="small error-text composer-error">{dictation.error}</p>}
      <span className="visually-hidden" role="status">
        {dictation.listening ? 'Listening' : ''}
      </span>
      {/* While an approval is pending the card needs the room (landscape especially),
          and a new prompt could not be acted on until it is answered anyway. */}
      <div className="composer-row" hidden={rowHidden}>
        {dictation.supported && hasText && !dictation.listening && (
          // Keep dictating after typing or a first phrase; the main button sends.
          <button
            className="composer-mini"
            onClick={dictate}
            disabled={disabled}
            aria-label="Dictate more"
          >
            <MicIcon size={22} />
          </button>
        )}
        <textarea
          ref={inputRef}
          className="input composer-input"
          rows={1}
          value={preview}
          aria-label="Instruction for Claude"
          placeholder={
            dictation.listening
              ? dictation.remote
                ? 'Speaking to Claude Code on the PC…'
                : 'Listening…'
              : dictation.supported
                ? dictation.remote
                  ? 'Type here, or hold the mic to dictate on the PC'
                  : 'Ask Claude, or tap the mic'
                : 'Ask Claude (use your keyboard’s mic to dictate)'
          }
          onChange={(e) => updateText(e.target.value)}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
              e.preventDefault();
              submit();
            }
          }}
          readOnly={dictation.listening && !dictation.remote}
          disabled={disabled}
          maxLength={LIMITS.maxPromptLength}
        />
        <button
          className={`composer-action composer-action-${action}`}
          onClick={onAction}
          disabled={disabled || (action === 'send' && !hasText)}
          aria-label={
            action === 'stop-dictation' ? 'Stop dictation' : action === 'send' ? 'Send' : 'Dictate'
          }
        >
          {action === 'stop-dictation' ? (
            <StopIcon />
          ) : action === 'send' ? (
            <SendIcon />
          ) : (
            <MicIcon />
          )}
        </button>
      </div>
    </div>
  );
}
