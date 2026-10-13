// VoiceCode service worker. It exists so approval alerts can be shown as system
// notifications (Android only allows those from a service worker) and so the app is
// installable. It deliberately does not cache anything: the app is useless without a
// live connection to the agent, and stale cached code would be worse than none.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => new URL(c.url).origin === self.location.origin);
      return client ? client.focus() : self.clients.openWindow('/');
    }),
  );
});
