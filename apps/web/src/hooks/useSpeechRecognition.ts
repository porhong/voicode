import { useCallback, useEffect, useRef, useState } from 'react';

// Minimal typings for the Web Speech API (not yet in TypeScript's DOM lib everywhere).
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed':
    'Microphone access was denied. Allow it in the browser settings (the page must be HTTPS and trusted).',
  'service-not-allowed': 'Speech recognition is not allowed in this browser.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition needs a network connection on this device.',
};

/**
 * Dictation via the browser's Web Speech API. Audio never touches the agent; only the
 * final transcript is sent as a prompt. `onFinal` is called with each finalized phrase,
 * `onEnd` when dictation stops.
 */
export const speechRecognitionSupported = () =>
  typeof window !== 'undefined' && recognitionCtor() !== undefined;

export function useSpeechRecognition(options: {
  lang: string;
  onFinal: (text: string) => void;
  onEnd?: () => void;
}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string>();
  const recognitionRef = useRef<Recognition | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const supported = speechRecognitionSupported();

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recognitionRef.current) return;
    const recognition = new Ctor();
    recognition.lang = optionsRef.current.lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) optionsRef.current.onFinal(result[0].transcript.trim());
        else pending += result[0].transcript;
      }
      setInterim(pending);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`);
      }
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterim('');
      optionsRef.current.onEnd?.();
    };

    setError(undefined);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => recognitionRef.current?.stop(), []);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, interim, error, start, stop };
}
