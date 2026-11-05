// Stetig startet sofort aus dem Zwischenspeicher, auch bei schlechtem Netz.
// Im Hintergrund holt die App die neueste Version. Sie gilt ab dem nächsten Öffnen.
const CACHE = "stetig-v8";
const ASSETS = ["./", "index.html", "style.css", "pwa.css", "app.js", "config.js", "library.js", "insights.js", "account.js", "ai.js", "register.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isOwn = url.origin === location.origin;
  if (!isOwn && !FONT_HOSTS.includes(url.hostname)) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const fresh = fetch(req).then(res => {
        if (res.ok || res.type === "opaque") cache.put(req, res.clone());
        return res;
      });
      if (cached) { fresh.catch(() => {}); return cached; }
      return fresh.catch(async () => (isOwn && (await cache.match("index.html"))) || Response.error());
    })
  );
});
