self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
	// Bypass cache; always network
	e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request)));
});

