importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBom74t2rJgZAyBzTeNfAzCn-sjUOo5RiA",
  authDomain: "nextlevel-chat.firebaseapp.com",
  databaseURL: "https://nextlevel-chat-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nextlevel-chat",
  storageBucket: "nextlevel-chat.firebasestorage.app",
  messagingSenderId: "746627471179",
  appId: "1:746627471179:web:57755e101e5edb0058bace"
});

const messaging = firebase.messaging();
const APP_ICON = "nela.jpg";

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first fetch handler agar memenuhi syarat PWA WebAPK penuh & update GitHub langsung masuk
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

messaging.onBackgroundMessage((payload) => {
  const data = (payload && payload.data) || {};
  const notif = (payload && payload.notification) || {};
  const title = notif.title || data.title || "Nela NEXT LEVEL";
  const body = notif.body || data.body || "Ada pembaruan baru di NEXT LEVEL";
  const url = data.url || "/";
  const tag = data.tag || data.orderId || "nextlevel-push";

  return self.registration.showNotification(title, {
    body,
    icon: APP_ICON,
    badge: APP_ICON,
    vibrate: [250, 120, 250, 120, 400],
    requireInteraction: true,
    tag,
    data: { url, orderId: data.orderId || "" }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          if (targetUrl && targetUrl !== '/' && 'navigate' in client) {
            client.navigate(targetUrl).catch(() => {});
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
