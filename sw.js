// Tiene l'app disponibile senza rete. Cambiare VERSIONE a ogni aggiornamento dei file.
const VERSIONE = 'ordini-v7';
const FILE = ['./', 'index.html', 'app.js', 'style.css', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomi) => Promise.all(nomi.filter((n) => n !== VERSIONE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Solo i file dell'app: le chiamate ad Apps Script passano sempre dalla rete
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((salvata) => {
      const rete = fetch(e.request).then((r) => {
        if (r.ok) caches.open(VERSIONE).then((c) => c.put(e.request, r.clone()));
        return r;
      }).catch(() => salvata);
      return salvata || rete;
    })
  );
});
