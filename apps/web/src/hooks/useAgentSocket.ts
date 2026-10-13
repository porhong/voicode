import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { WS_PATH, type ClientMessage, type ServerMessage } from '@voicecode/protocol';
import { api } from '../lib/api';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'unpaired';

const CLOSE_REVOKED = 4001;

/**
 * WebSocket connection to the agent with exponential backoff + jitter, eager
 * reconnects when the page becomes visible or the network returns, and detection of
 * revoked/unknown devices (the agent rejects the upgrade, so we ask /api/info).
 */
export function useAgentSocket(onMessage: (message: ServerMessage) => void) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  useLayoutEffect(() => {
    handlerRef.current = onMessage;
  });

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      const ws = new WebSocket(`wss://${location.host}${WS_PATH}`);
      socketRef.current = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setState('open');
      };
      ws.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(event.data as string) as ServerMessage);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = async (event) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        if (event.code === CLOSE_REVOKED) return setState('unpaired');
        if (!opened) {
          // The upgrade was rejected or the agent is down; distinguish the two.
          const paired = await api.info().then(
            (i) => i.paired,
            () => true,
          );
          if (!paired) return setState('unpaired');
        }
        setState('reconnecting');
        const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
        timer = window.setTimeout(connect, delay);
      };
    };

    const reconnectNow = () => {
      const ws = socketRef.current;
      if (document.visibilityState === 'visible' && (!ws || ws.readyState === WebSocket.CLOSED)) {
        attempt = 0;
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', reconnectNow);
    window.addEventListener('online', reconnectNow);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', reconnectNow);
      window.removeEventListener('online', reconnectNow);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  return { state, send };
}

export type Send = (message: ClientMessage) => void;
