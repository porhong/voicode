import { useRef, useState } from 'react';
import { LIMITS } from '@voicecode/protocol';
import { stopSpeaking } from '../hooks/useSpeakReplies';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import type { Settings } from '../hooks/useSettings';

interface Props {
  disabled: boolean;
  busy: boolean;
  settings: Settings;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

/**
 * Prompt input with dictation. Speech is transcribed in the browser and lands in the
 * text box so it can be reviewed and edited before sending (unless auto-send is on).
 */
export function Composer({ disabled, busy, settings, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('');
  // Mirrors `text` for callbacks that fire outside React's render cycle (speech events).
  const textRef = useRef('');
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

  const speech = useSpeechRecognition({
    lang: settings.voiceLang,
    onFinal: (phrase) => {
      const prev = textRef.current;
      updateText(prev ? `${prev} ${phrase}` : phrase);
    },
    onEnd: () => {
      if (settings.autoSendVoice) submit();
    },
  });

  const preview = speech.interim ? `${text}${text ? ' ' : ''}${speech.interim}` : text;

  return (
    <div className="composer">
      {speech.error && <p className="small error-text">{speech.error}</p>}
      <div className="composer-row">
        <textarea
          className="input composer-input"
          rows={2}
          value={preview}
          placeholder={
            speech.supported
              ? 'Speak or type an instruction…'
              : 'Type an instruction (use your keyboard’s mic to dictate)…'
          }
          onChange={(e) => updateText(e.target.value)}
          readOnly={speech.listening}
          disabled={disabled}
          maxLength={LIMITS.maxPromptLength}
        />
      </div>
      <div className="composer-actions">
        {speech.supported && (
          <button
            className={`mic ${speech.listening ? 'listening' : ''}`}
            onClick={() => {
              if (speech.listening) return speech.stop();
              // Don't let a reply being read aloud leak into the microphone.
              stopSpeaking();
              speech.start();
            }}
            disabled={disabled}
            aria-pressed={speech.listening}
            aria-label={speech.listening ? 'Stop dictation' : 'Start dictation'}
          >
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path
                d="M6 11a6 6 0 0 0 12 0M12 17v4"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        {busy && (
          <button className="btn btn-ghost" onClick={onInterrupt}>
            Stop
          </button>
        )}
        <button
          className="btn btn-primary send"
          onClick={() => submit()}
          disabled={disabled || speech.listening || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
