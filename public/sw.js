const CACHE_NAME = "pi-ez-web-shell-v2";
const SHELL = [
  "./",
  "./manifest.webmanifest",
  "./app.css",
  "./js/main.js",
  "./js/api.js",
  "./js/markdown.js",
  "./js/panels.js",
  "./js/panel-utils.js",
  "./js/dialogs.js",
  "./js/session-picker.js",
  "./js/project-menu.js",
  "./js/settings.js",
  "./js/files.js",
  "./js/repo-picker.js",
  "./js/app.js",
  "./js/operations.js",
  "./js/shell.js",
  "./js/store.js",
  "./js/thread.js",
  "./js/workers.js",
  "./js/hints.js",
  "./vendor/marked.umd.js",
  "./vendor/dompurify.min.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("pi-ez-web-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.href.startsWith(new URL("api/", self.registration.scope).href) || url.href === new URL("sw.js", self.registration.scope).href) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(self.registration.scope, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(self.registration.scope)) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      // Network-first prevents an installed app from pinning an older UI after
      // a deployment. The shell cache exists solely as an offline fallback.
      const response = await fetch(request);
      if (response.ok && ["script", "style", "image", "font", "manifest"].includes(request.destination)) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(request)) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
