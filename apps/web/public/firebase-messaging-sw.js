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

  // Initialising messaging is what registers the SDK's own push and
  // notificationclick handlers, and those are deliberately the only ones here.
  //
  // This file used to render the notification itself from onBackgroundMessage. Two
  // end-to-end measurements on clean browser profiles showed why that was wrong:
  // with the server sending android+apns blocks the browser displayed TWO
  // notifications (the SDK's and ours, and only ours carried the room link), and
  // with those blocks removed it displayed NONE -- our handler was not what had
  // been rendering. The server now sends webpush.notification plus
  // fcm_options.link, which the SDK renders once and routes on click, focusing an
  // existing tab rather than opening a second copy of the app.
  firebase.messaging();
}

/*
 * No notificationclick listener here on purpose. The SDK registers its own, which
 * opens fcm_options.link and focuses an existing tab for that URL instead of
 * spawning a second copy of the app. A listener of ours would fire alongside it
 * and, seeing none of its own data on an SDK-rendered notification, send every
 * click to '/' instead of the room.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
