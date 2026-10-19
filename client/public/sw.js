// Kindred service worker: push notifications, plus one offline page. Nothing else is
// cached, so a new deploy is picked up immediately and nobody gets stuck on an old version.
// The offline page matters for the store apps: without it a lost connection shows the
// browser's own error screen, which Play's quality checks treat as a broken app.
const OFFLINE = 'kindred-offline-v1';
const OFFLINE_FILES = ['/offline.html', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE).then((c) => c.addAll(OFFLINE_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== OFFLINE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Pages load from the network as always; only when that fails does the offline page show.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  } else if (OFFLINE_FILES.includes(new URL(req.url).pathname) && new URL(req.url).origin === self.location.origin) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // ignore malformed payloads
  }
  event.waitUntil((async () => {
    // Skip the notification if Kindred is already open and visible.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'Kindred', {
      body: data.body || 'You have a new message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow(event.notification.data?.url || '/');
  })());
});
