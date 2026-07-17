// Class Log service worker — offline shell + install support.
// HTML is network-first (so deploys are picked up when online, with an offline fallback).
// /api/* is never cached (class logs, substitutions and holidays must be live).
// Static assets (icons, manifest, logo) are cache-first.
const CACHE = "classlog-v1";
const SHELL = [
  "/", "/index.html", "/manifest.json",
  "/logo.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never intercept POST etc.
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return; // let cross-origin (fonts, APIs elsewhere) pass through
  if (url.pathname.startsWith("/api/")) return;     // always hit the network for data

  if (req.mode === "navigate") {
    // network-first for the app shell
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("/index.html", cp)); return r; })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // cache-first for static assets
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
        return res;
      }).catch(() => cached)
    )
  );
});
