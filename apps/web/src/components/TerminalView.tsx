import { useEffect, useLayoutEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { ServerMessage } from '@voicecode/protocol';
import type { Send } from '../hooks/useAgentSocket';

/** Keys phones cannot type easily; Claude Code's prompts and menus need them. */
const KEYS: Array<[label: string, data: string]> = [
  ['Enter', '\r'],
  ['Esc', '\x1b'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['Tab', '\t'],
  ['Space', ' '],
  ['y', 'y'],
  ['n', 'n'],
  ['Ctrl+C', '\x03'],
];

export type TerminalMessage = Extract<
  ServerMessage,
  { type: 'terminal.snapshot' | 'terminal.data' | 'terminal.exit' }
>;

interface Props {
  sessionId: string;
  send: Send;
  /** Registers for the session's terminal messages; returns the unsubscribe function. */
  subscribe: (listener: (message: TerminalMessage) => void) => () => void;
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The raw terminal of a Claude Code voice session, for what the phone transcript
 * cannot show: the dictation footer, errors, and questions only the CLI asks. Keys typed
 * here go straight to Claude Code.
 */
export function TerminalView({ sessionId, send, subscribe }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sendRef = useRef(send);
  useLayoutEffect(() => {
    sendRef.current = send;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      cursorBlink: false,
      scrollback: 2000,
      convertEol: false,
      allowProposedApi: true,
      theme: { background: '#14161a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const size = () => ({ cols: Math.max(20, term.cols), rows: Math.max(5, term.rows) });
    sendRef.current({ type: 'terminal.subscribe', sessionId, ...size() });
    const unsubscribe = subscribe((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.type === 'terminal.snapshot') {
        term.reset();
        term.write(decode(message.data));
      } else if (message.type === 'terminal.data') {
        term.write(decode(message.data));
      } else {
        term.write(`\r\n\x1b[2m[Claude Code exited with code ${message.code}]\x1b[0m\r\n`);
      }
    });
    const input = term.onData((data) =>
      sendRef.current({ type: 'terminal.input', sessionId, data }),
    );
    const observer = new ResizeObserver(() => {
      fit.fit();
      sendRef.current({ type: 'terminal.resize', sessionId, ...size() });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      input.dispose();
      unsubscribe();
      sendRef.current({ type: 'terminal.unsubscribe' });
      term.dispose();
    };
  }, [sessionId, subscribe]);

  return (
    <div className="terminal-panel">
      <div ref={hostRef} className="terminal-screen" aria-label="Claude Code terminal" />
      <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
        {KEYS.map(([label, data]) => (
          <button
            key={label}
            className="btn btn-small btn-ghost"
            onClick={() => send({ type: 'terminal.input', sessionId, data })}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
