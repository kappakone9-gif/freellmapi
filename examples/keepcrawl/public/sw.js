// Minimal service worker: makes KeepCrawl installable as an app (needed for the
// Android share sheet). It does not cache anything; every request goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
