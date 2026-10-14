import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { LIMITS } from '@voicecode/protocol';
import { stopSpeaking } from '../hooks/useSpeakReplies';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { Settings } from '../hooks/useSettings';
import { MicIcon, SendIcon, StopIcon } from './Icons';

export interface ComposerHandle {
  /** Replaces the draft (e.g. with a suggested prompt) and focuses the input. */
  setDraft: (text: string) => void;
}

interface Props {
  ref?: Ref<ComposerHandle>;
  disabled: boolean;
  /** What Claude is doing in this session, if anything. */
  activity?: 'running' | 'awaiting_permission';
  /** An approval card is on screen: the input row steps aside to give it the room. */
  approvalShown: boolean;
  settings: Settings;
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
  onSend,
  onInterrupt,
}: Props) {
  const [text, setText] = useState('');
  // Mirrors `text` for callbacks that fire outside React's render cycle (speech events).
  const textRef = useRef('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const updateText = (next: string) => {
    textRef.current = next;
    setText(next);
  };

  useImperativeHandle(ref, () => ({
    setDraft: (draft: string) => {
      updateText(draft);
      inputRef.current?.focus();
    },
  }));

  const submit = (value = textRef.current) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed.slice(0, LIMITS.maxPromptLength));
    updateText('');
  };

  const suppressAutoSendRef = useRef(false);
  const speech = useSpeechRecognition({
    lang: settings.voiceLang,
    onFinal: (phrase) => {
      const prev = textRef.current;
      updateText(prev ? `${prev} ${phrase}` : phrase);
    },
    onEnd: () => {
      if (settings.autoSendVoice && !suppressAutoSendRef.current) submit();
      suppressAutoSendRef.current = false;
    },
  });

  // The input row (and its stop button) is hidden while an approval is shown, so a
  // running dictation is stopped rather than left listening with no way to end it.
  // Its text stays in the box for review instead of being auto-sent.
  const { listening, stop } = speech;
  useEffect(() => {
    if (approvalShown && listening) {
      suppressAutoSendRef.current = true;
      stop();
    }
  }, [approvalShown, listening, stop]);

  const preview = speech.interim ? `${text}${text ? ' ' : ''}${speech.interim}` : text;

  // Grow with the content up to the CSS max-height, then scroll inside. Skipped while
  // the row is hidden (it would measure 0) and redone when it is shown again.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || el.offsetParent === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [preview, approvalShown]);

  const hasText = text.trim().length > 0;
  const action: 'stop-dictation' | 'send' | 'dictate' = speech.listening
    ? 'stop-dictation'
    : hasText || !speech.supported
      ? 'send'
      : 'dictate';

  const dictate = () => {
    // Don't let a reply being read aloud leak into the microphone.
    stopSpeaking();
    navigator.vibrate?.(10);
    speech.start();
  };
  const onAction = () => {
    if (action === 'stop-dictation') return speech.stop();
    if (action === 'send') return submit();
    dictate();
  };

  return (
    <div className="composer">
      {activity && (
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
      {speech.error && <p className="small error-text composer-error">{speech.error}</p>}
      <span className="visually-hidden" role="status">
        {speech.listening ? 'Listening' : ''}
      </span>
      {/* While an approval is pending the card needs the room (landscape especially),
          and a new prompt could not be acted on until it is answered anyway. */}
      <div className="composer-row" hidden={approvalShown}>
        {speech.supported && hasText && !speech.listening && (
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
            speech.listening
              ? 'Listening…'
              : speech.supported
                ? 'Ask Claude, or tap the mic'
                : 'Ask Claude (use your keyboard’s mic to dictate)'
          }
          onChange={(e) => updateText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
              e.preventDefault();
              submit();
            }
          }}
          readOnly={speech.listening}
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
