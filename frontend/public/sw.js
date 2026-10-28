/* MEET ENIHAKOLE service worker: offline fallback + static asset caching.
   API calls, media and live-meeting traffic are never cached. */
const VERSION = "v1";
const STATIC_CACHE = `meet-enihakole-static-${VERSION}`;
const PRECACHE = ["/offline.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("meet-enihakole-") && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API / LiveKit / fonts: go straight to network
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/share/")) return;

  // Page navigations: network first, offline page when the network is unavailable.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/offline.html").then((r) => r || Response.error())),
    );
    return;
  }

  // Built static assets & icons: cache first, refresh in background.
  if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname) || /\.(?:png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      }),
    );
  }
});
