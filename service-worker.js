/**
 * Service Worker fuer die Feld-Erfassung-PWA.
 *
 * Cached nur das App-Shell (HTML/CSS/JS/Icons/Manifest), damit die App
 * offline startet -- Daten selbst liegen in IndexedDB, nicht hier.
 * Externe Requests (z. B. Nominatim/Overpass) laufen unveraendert am
 * Cache vorbei.
 *
 * Strategie: NETWORK-FIRST mit kurzem Timeout und Cache als Fallback.
 * Cache-first waere fuer eine Offline-App naheliegender, sorgt hier aber
 * dafuer, dass nach einem Deploy immer erst die ALTE Version erscheint und
 * die neue erst beim uebernaechsten Start -- auf dem Handy praktisch nicht
 * nachvollziehbar. Das App-Shell ist wenige zehn KB gross, der Netzabruf
 * kostet also kaum etwas; bei Funkloch oder langsamer Verbindung greift
 * nach TIMEOUT_MS der Cache, die App startet also weiterhin offline.
 *
 * Versionsnummer im CACHE-Namen hochzaehlen, wenn sich App-Shell-Dateien
 * aendern -- dann werden alte Caches beim Aktivieren entfernt.
 */
const CACHE = 'wk-feld-erfassung-v11';
const TIMEOUT_MS = 3000;

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

async function networkFirst(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      // Antwort klonen, bevor sie an die Seite geht -- ein Body ist nur
      // einmal lesbar.
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    const cached = await caches.match(request);
    if (cached) return cached;
    // Weder Netz noch Cache: fuer Navigationen wenigstens das Shell liefern.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // fremde Hosts unangetastet lassen

  event.respondWith(networkFirst(event.request));
});
