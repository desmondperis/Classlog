// Class Log service worker — predictable offline shell caching.
// API requests are never cached. Navigation pages keep their own cache keys.
const CACHE = "classlog-v3";
const SHELL = [
  "/", "/index.html", "/manifest.json", "/about", "/privacy", "/terms",
  "/logo.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) =>
        fetch(url).then((response) => {
          if (response && response.ok) return cache.put(url, response);
        }).catch(() => undefined)
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("classlog-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (url.pathname === "/" || url.pathname === "/index.html") return caches.match("/index.html");
          return new Response("You are offline and this page has not been cached yet.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) =>
      cached || fetch(request).then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
    )
  );
});
