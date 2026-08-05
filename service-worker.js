/**
 * Service Worker fuer die Feld-Erfassung-PWA.
 *
 * Cached nur das App-Shell (HTML/CSS/JS/Icons/Manifest), damit die App
 * offline startet -- Daten selbst liegen in IndexedDB, nicht hier.
 * Externe Requests (z. B. der optionale Reverse-Geocoding-Call) laufen
 * unveraendert am Cache vorbei.
 *
 * Versionsnummer im CACHE-Namen hochzaehlen, wenn sich App-Shell-Dateien
 * aendern, sonst greift der Browser weiter auf die alte Version zurueck.
 */
const CACHE = 'wk-feld-erfassung-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // fremde Hosts unangetastet lassen

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
