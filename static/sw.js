const TILE_CACHE = "tile-cache-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = e.request.url;
  // Only cache tile requests from CARTO basemaps
  if (!url.includes("basemaps.cartocdn.com")) return;

  e.respondWith(
    caches.open(TILE_CACHE).then((cache) =>
      cache.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          if (response.ok) cache.put(e.request, response.clone());
          return response;
        });
      })
    )
  );
});
