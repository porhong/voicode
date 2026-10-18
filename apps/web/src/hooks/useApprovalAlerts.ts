import { useEffect, useRef } from 'react';
import type { PermissionRequest } from '@voicecode/protocol';
import { setTitlePending } from '../lib/title';

export function notificationsSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

/** Asks for notification permission; must be called from a user gesture. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  return (await Notification.requestPermission()) === 'granted';
}

/**
 * Draws attention to new approval requests: the page title shows the pending count,
 * the phone vibrates, and — when enabled and the page is in the background — a system
 * notification is shown through the service worker.
 */
export function useApprovalAlerts(requests: PermissionRequest[], notify: boolean): void {
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setTitlePending(requests.length);

    const fresh = requests.filter((r) => !seen.current.has(r.requestId));
    seen.current = new Set(requests.map((r) => r.requestId));
    if (!fresh.length) return;

    navigator.vibrate?.([120, 60, 120]);
    if (!notify || document.visibilityState === 'visible') return;
    if (!notificationsSupported() || Notification.permission !== 'granted') return;

    void navigator.serviceWorker.ready.then((registration) => {
      for (const request of fresh) {
        void registration.showNotification('Claude needs your approval', {
          body: `${request.title}\n${request.detail.split('\n')[0] ?? ''}`.slice(0, 200),
          tag: request.requestId,
          icon: '/icon.svg',
          requireInteraction: true,
        });
      }
    });
  }, [requests, notify]);

  // Clear notifications for requests that have been answered (on any device).
  useEffect(() => {
    if (!notificationsSupported() || Notification.permission !== 'granted') return;
    const pending = new Set(requests.map((r) => r.requestId));
    void navigator.serviceWorker.ready.then(async (registration) => {
      for (const n of await registration.getNotifications()) {
        if (n.tag && !pending.has(n.tag)) n.close();
      }
    });
  }, [requests]);
}
