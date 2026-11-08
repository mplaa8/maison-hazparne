// Service worker : permet l'ouverture hors connexion et l'installation.
// Stratégie « réseau d'abord » pour toujours avoir la dernière version.
const CACHE = "maison-hazparne-v5";
const SHELL = ["./", "index.html", "style.css", "app.js", "store.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/apple-touch-icon.png", "icons/icon.svg", "images/maison.webp", "images/maison.jpg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const isFirebaseSdk = (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))
    || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (req.method !== "GET" || (url.origin !== self.location.origin && !isFirebaseSdk)) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
  );
});
