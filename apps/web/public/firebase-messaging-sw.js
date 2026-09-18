/* eslint-disable no-undef */
/**
 * FR-NOTI-003 — background push service worker (FCM Web).
 *
 * This is the half of web notifications that a page cannot do. A `Notification`
 * constructed by page code dies with the tab; on a phone the tab is frozen the
 * moment you switch apps. Only a service worker keeps receiving pushes after that.
 *
 * CONFIG AT REGISTRATION TIME, NOT BUILD TIME. A service worker is a static file
 * served from the origin root, so it cannot read Vite's import.meta.env. Rather than
 * template this file during the build (which would make it a build artifact and
 * break the "serve it from public/" contract), the page passes the Firebase config
 * in the registration URL's query string and we read it back from location.search.
 * That also means the same deployed file works for staging and prod unchanged.
 *
 * Deliberately NO fetch handler and NO precaching. A caching SW here would have to
 * carefully exclude /api, /broadcasting and the Reverb websocket, and the spec's
 * offline section does not ask the web client for one. Push only.
 */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
const config = {
  apiKey: params.get('apiKey') || '',
  projectId: params.get('projectId') || '',
  messagingSenderId: params.get('messagingSenderId') || '',
  appId: params.get('appId') || '',
};

// Unconfigured is a normal state: the app ships with push dormant until an operator
// supplies Firebase credentials. Registering anyway (and doing nothing) keeps the
// page logic simple -- it never has to branch on "is the SW there".
if (config.apiKey && config.projectId && config.messagingSenderId && config.appId) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    // The server sends BOTH `notification` and `data` (§10). When a `notification`
    // block is present Chrome may render it automatically; showing our own as well
    // would double up, so we key off data and use a tag so repeats collapse.
    const title = data.title || 'Banana Chat';
    const body = data.body || 'ข้อความใหม่';
    const roomId = data.room_id || '';

    return self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: roomId || 'banana-chat',
      renotify: false,
      data: {
        // Where a click should land. Computed here so the click handler stays dumb.
        url: roomId ? `/rooms/${roomId}` : '/',
      },
    });
  });
}

/**
 * Focus an existing tab if one is open rather than spawning a second copy of the
 * app -- a chat app with three tabs of itself is its own bug report.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // navigate() can reject on cross-origin or if the client is unloading;
          // focusing is the part that matters, so never let it break the handler.
          if ('navigate' in client) {
            client.navigate(target).catch(() => {});
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// Take over without waiting for every old tab to close, so a deployed fix to this
// file applies on the next page load rather than whenever the user happens to
// close every tab.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
