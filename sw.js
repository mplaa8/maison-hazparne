// Service worker « fait main » : l'app s'ouvre et fonctionne hors connexion.
// - HTML : réseau d'abord (dernière version quand on est en ligne), sinon la copie en cache.
// - Reste de l'app (CSS, JS, icônes, photos, polices, SDK Firebase) : cache d'abord.
// - Données de l'Agenda (data/*.json, mises à jour chaque nuit) : réseau d'abord, sinon le cache.
// - VERSION change à chaque publication : la nouvelle version s'installe en arrière-plan et l'app
//   propose « Mettre à jour » (pas de rechargement automatique).
// Les données du planning ne passent pas par ici : c'est le cache persistant de Firestore qui les garde.
const VERSION = "2026-11-10-1912";
const APP_CACHE = "mh-app-" + VERSION;
const RUNTIME_CACHE = "mh-runtime-v1"; // polices, SDK, images de l'Agenda, données : gardé d'une version à l'autre

const FONTS_CSS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,500..600,100,0&family=Hanken+Grotesk:wght@400..700&display=swap";
const FIREBASE = [
  "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js",
];
const SHELL = [
  "./", "index.html", "style.css", "app.js", "store.js", "agenda.js", "memo.js", "places.js", "config.js", "manifest.webmanifest",
  "icons/icon.svg?v=2", "icons/favicon-32.png?v=2", "icons/icon-192.png?v=2", "icons/apple-touch-icon.png?v=2",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/icon.svg",
  "images/maison.webp", "images/maison.jpg", "images/maison-nuit.webp", "images/maison-nuit.jpg",
];

/** Met en cache la feuille de style Google Fonts et les fichiers de polices qu'elle référence. */
async function cacheFonts() {
  const c = await caches.open(RUNTIME_CACHE);
  const res = await fetch(FONTS_CSS);
  if (!res.ok) return;
  await c.put(FONTS_CSS, res.clone());
  const css = await res.text();
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]))];
  await Promise.all(urls.map(async (u) => { if (!(await c.match(u))) { const r = await fetch(u, { mode: "cors" }); if (r.ok) await c.put(u, r); } }));
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const app = await caches.open(APP_CACHE);
    // « reload » : on prend les fichiers sur le serveur, pas dans le cache HTTP du navigateur.
    await app.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    const rt = await caches.open(RUNTIME_CACHE);
    await Promise.all(FIREBASE.map(async (u) => { if (!(await rt.match(u))) { const r = await fetch(u, { mode: "cors" }); if (r.ok) await rt.put(u, r); } }));
    try { await cacheFonts(); } catch { /* polices : on réessaiera à l'utilisation */ }
    // Pas de skipWaiting ici : l'app propose « Mettre à jour ».
  })());
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== APP_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** La page et le code doivent être de la même version : si le serveur a déjà une page plus récente
 *  que ce service worker, on sert la page en cache (cohérente avec le JS en cache) et on va chercher
 *  la nouvelle version, que l'app proposera d'installer. */
async function navigate(req) {
  const cached = async () => (await caches.match("index.html", { cacheName: APP_CACHE })) || (await caches.match("./", { cacheName: APP_CACHE }));
  let res;
  try { res = await fetch(req); } catch {
    return (await cached()) || Response.error();
  }
  if (!res.ok) return (await cached()) || res;
  const html = await res.clone().text();
  const v = (html.match(/<meta name="app-version" content="([^"]+)"/) || [])[1];
  if (v && v !== VERSION) {
    const old = await cached();
    if (old) { self.registration.update().catch(() => { }); return old; }
    return res;
  }
  (await caches.open(APP_CACHE)).put("index.html", res.clone());
  return res;
}

async function networkFirst(req, cacheName, fallbackKey) {
  try {
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(cacheName); c.put(fallbackKey || req, res.clone()); }
    return res;
  } catch (err) {
    const hit = await caches.match(fallbackKey || req);
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req, cacheName, opts) {
  const hit = await caches.match(req, opts);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") { const c = await caches.open(cacheName); c.put(req, res.clone()); }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pages HTML : réseau d'abord, sinon index.html en cache (quelle que soit l'ancre ou la requête).
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith(navigate(req));
    return;
  }

  if (url.origin === self.location.origin) {
    // Données de l'Agenda : réseau d'abord (mises à jour chaque nuit), sinon la dernière copie.
    if (url.pathname.includes("/data/")) {
      const key = new Request(url.origin + url.pathname);
      e.respondWith(networkFirst(req, RUNTIME_CACHE, key));
      return;
    }
    // Fichiers de l'app : cache d'abord (versionné), puis réseau.
    e.respondWith(cacheFirst(req, url.pathname.includes("/images/agenda/") ? RUNTIME_CACHE : APP_CACHE));
    return;
  }

  // Polices, SDK Firebase (URL versionnées) : cache d'abord.
  if (url.hostname === "fonts.gstatic.com" || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }
  // Feuille de style des polices : cache d'abord, rafraîchie en arrière-plan quand on est en ligne.
  if (url.hostname === "fonts.googleapis.com") {
    e.respondWith(caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone())); return res; });
      if (hit) { e.waitUntil(net.catch(() => { })); return hit; }
      return net;
    }));
  }
  // Tout le reste (Firestore, OpenStreetMap, sites externes) : pas d'interception.
});
