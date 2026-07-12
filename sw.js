/* RNGD Look-Ahead — service worker
   - App shell (same-origin) is cached on install (cache-first) so the tool opens
     with no signal on the jobsite.
   - Cross-origin runtime deps (unpkg React/ReactDOM/Babel, Google Fonts) are
     cached stale-while-revalidate on first successful online load, so the app
     fully boots offline afterwards. */
const VERSION = "rngd-v15";
const SHELL = VERSION + "-shell";
const RUNTIME = VERSION + "-runtime";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/rngd-white.png",
  "./assets/rngd-black.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable.png",
  "./assets/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Sync endpoint: never cache, and never let the index.html fallback answer it.
  if (url.pathname.startsWith("/api/")) return;
  const sameOrigin = url.origin === self.location.origin;

  // App shell / navigations: cache-first, fall back to network, then cached index.
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then(hit => hit ||
        fetch(req).then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
          return res;
        }).catch(() => caches.match("./index.html"))
      )
    );
    return;
  }

  // Cross-origin CDNs (unpkg, Google Fonts): stale-while-revalidate.
  e.respondWith(
    caches.open(RUNTIME).then(cache =>
      cache.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    )
  );
});
