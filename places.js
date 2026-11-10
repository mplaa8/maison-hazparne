// Onglet « Agenda » › « Restos & bars » : les bonnes adresses de la famille.
// Toutes les données (adresses, notes, photos) sont dans Firestore, sous le chemin secret du planning :
// rien n'est dans le code ni dans le dépôt. Les photos sont compressées dans le navigateur
// (pas de Firebase Storage) : miniature ≈ 300 px (< 25 Ko) et photo ≤ 1280 px (< 200 Ko).
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const CARD_COLORS = ["#2b535c", "#b5654a", "#5e7d4e", "#6b5b8a", "#3f6f8f", "#9a6b2f", "#7a4b5c", "#4b6b6b"];
const TYPES = { resto: "Restaurant", bar: "Bar", cafe: "Café", cidrerie: "Cidrerie", autre: "Autre" };
const HOME = { lat: 43.3843, lon: -1.3053 };
const LS_MODE = "mh.agmode";

// Villes de la zone (coordonnées du centre, approximatives) : suggestions de saisie,
// et distance de secours si l'adresse n'a pas pu être localisée.
const CITIES = {
  "Hasparren": [43.3843, -1.3053], "Bayonne": [43.4929, -1.4748], "Anglet": [43.4850, -1.5167], "Biarritz": [43.4832, -1.5586],
  "Bidart": [43.4378, -1.5908], "Guéthary": [43.4247, -1.6086], "Saint-Jean-de-Luz": [43.3881, -1.6631], "Ciboure": [43.3853, -1.6697],
  "Urrugne": [43.3631, -1.6997], "Hendaye": [43.3586, -1.7744], "Ascain": [43.3456, -1.6203], "Sare": [43.3125, -1.5803],
  "Saint-Pée-sur-Nivelle": [43.3558, -1.5506], "Ainhoa": [43.3069, -1.4994], "Espelette": [43.3403, -1.4472],
  "Cambo-les-Bains": [43.3583, -1.4019], "Itxassou": [43.3283, -1.4053], "Ustaritz": [43.3975, -1.4569], "Larressore": [43.3700, -1.4400],
  "Louhossoa": [43.3222, -1.3433], "Macaye": [43.3236, -1.3236], "Mendionde": [43.3500, -1.2833], "Bonloc": [43.3600, -1.2500],
  "Ayherre": [43.3936, -1.2558], "La Bastide-Clairence": [43.4278, -1.2483], "Briscous": [43.4594, -1.3369], "Urt": [43.4931, -1.2919],
  "Hélette": [43.3017, -1.2408], "Saint-Palais": [43.3292, -1.0333], "Saint-Jean-Pied-de-Port": [43.1631, -1.2378],
  "Saint-Étienne-de-Baïgorry": [43.1767, -1.3381], "Hondarribia": [43.3622, -1.7914], "Donostia – Saint-Sébastien": [43.3183, -1.9812],
  "Pampelune – Iruñea": [42.8125, -1.6458],
};

let ctx = null;
const data = { places: [], ratings: [], loaded: false, error: false };
const ui = { mode: "events", sort: "top", type: "", city: "", placeId: null, upload: null };
let unsub = null, spaceId = null;
const detail = { placeId: null, photos: [], unsub: null, loaded: false, full: new Map() };

/* ---------- Utilitaires ---------- */
function kmFrom(lat, lon) {
  if (lat == null || lon == null) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat - HOME.lat) * rad, dLon = (lon - HOME.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(HOME.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}
function distLabel(p, long) {
  if (p.km == null) return "";
  const approx = p.geo === "city" ? "≈ " : "";
  if (p.km < 1.5 && (p.city || "").toLowerCase() === "hasparren") return "à Hasparren";
  return `${long ? "à " : ""}${approx}${p.km < 10 ? String(p.km).replace(".", ",") : Math.round(p.km)} km${long ? " de la maison" : ""}`;
}
function colorFor(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CARD_COLORS[h % CARD_COLORS.length]; }
const tsOf = (t) => t?.seconds ?? (typeof t === "number" ? t / 1000 : 9e9); // en attente d'écriture = le plus récent
const fmt1 = (x) => x.toFixed(1).replace(".", ",");
const price = (n) => (n ? "€".repeat(n) : "");
function dateOf(ts) {
  const d = ts?.toDate ? ts.toDate() : (typeof ts === "number" ? new Date(ts) : null);
  return d ? `${d.getDate()}${d.getDate() === 1 ? "er" : ""} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}` : "";
}
const starsHtml = (n, cls = "") => `<span class="pl-stars ${cls}" aria-label="${n} étoile${n > 1 ? "s" : ""} sur 5">${"★".repeat(n)}<span class="pl-stars-off">${"★".repeat(5 - n)}</span></span>`;
function ratingsOf(placeId) { return data.ratings.filter(r => r.placeId === placeId); }
function statsOf(placeId) {
  const r = ratingsOf(placeId);
  return { n: r.length, avg: r.length ? r.reduce((s, x) => s + (x.stars || 0), 0) / r.length : 0 };
}
const nameOf = (r) => ctx.memberById(r.memberId)?.name || r.memberName || "Quelqu'un";
const authorOf = (x) => (x.authorId && ctx.memberById(x.authorId)?.name) || x.authorName || "Quelqu'un";
const fail = (ex) => { console.error(ex); ctx.toast("Erreur d'enregistrement. Réessayez."); };
function isUrl(s) { return /^https?:\/\//i.test(String(s).trim()); }
function mapsHref(p) {
  if (isUrl(p.address)) return p.address.trim();
  const q = [p.address || p.name, p.address ? "" : p.city].filter(Boolean).join(", ");
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}

/* ---------- Géocodage (OpenStreetMap / Nominatim) ---------- */
// Règles d'usage de Nominatim : une seule requête, uniquement quand l'adresse est saisie ou modifiée,
// et le résultat est enregistré dans la fiche (jamais redemandé à l'affichage).
function coordsFromText(s) {
  const t = String(s || "");
  let m = t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || t.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i) || t.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
async function geocode({ name, city, address }) {
  const direct = coordsFromText(address);
  if (direct) return { ...direct, geo: "exact" };
  const q = address && !isUrl(address)
    ? (city && !address.toLowerCase().includes(city.toLowerCase()) ? `${address}, ${city}` : address)
    : [name, city].filter(Boolean).join(", ");
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 7000);
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=fr,es&accept-language=fr"
      + "&viewbox=-2.3,43.8,-0.7,42.6&bounded=1&q=" + encodeURIComponent(q);
    const r = await fetch(url, { signal: ctl.signal, headers: { "Accept": "application/json" } });
    clearTimeout(t);
    const j = r.ok ? await r.json() : [];
    if (j[0]) return { lat: +(+j[0].lat).toFixed(5), lon: +(+j[0].lon).toFixed(5), geo: "exact" };
  } catch (e) { console.warn("Géocodage impossible", e); }
  const c = CITIES[Object.keys(CITIES).find(k => k.toLowerCase() === String(city || "").trim().toLowerCase())];
  return c ? { lat: c[0], lon: c[1], geo: "city" } : { lat: null, lon: null, geo: "none" };
}

/* ---------- Photos : compression dans le navigateur ---------- */
async function loadImage(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { }
  }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const toBlob = (c, type, q) => new Promise(res => c.toBlob(res, type, q));
const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
/** Dessine l'image (recadrée sur sx,sy,sw,sh) à la taille w×h puis encode en WebP (ou JPEG) sous maxBytes. */
async function encode(img, [sx, sy, sw, sh], w, h, maxBytes) {
  for (let scale = 1; scale > 0.3; scale *= 0.85) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    for (const q of [0.72, 0.62, 0.52, 0.42]) {
      let b = await toBlob(c, "image/webp", q);
      if (!b || b.type !== "image/webp") b = await toBlob(c, "image/jpeg", q); // Safari ancien : pas de WebP
      if (b && b.size <= maxBytes) return toDataUrl(b);
    }
  }
  throw new Error("Photo trop lourde");
}
async function compress(file) {
  const img = await loadImage(file);
  const W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
  if (!W || !H) throw new Error("Image illisible");
  const k = Math.min(1, 1280 / Math.max(W, H));
  const full = await encode(img, [0, 0, W, H], W * k, H * k, 200 * 1024);
  // Miniature : petit côté 300 px, recadrée au centre en 4:3 au plus.
  const ratio = Math.max(W, H) / Math.min(W, H);
  const cropR = Math.min(ratio, 4 / 3);
  let sw = W, sh = H;
  if (W >= H) sw = H * cropR; else sh = W * cropR;
  const sx = (W - sw) / 2, sy = (H - sh) / 2;
  const t = 300 / Math.min(sw, sh);
  const thumb = await encode(img, [sx, sy, sw, sh], Math.min(sw * t, sw), Math.min(sh * t, sh), 25 * 1024);
  if (img.close) img.close();
  return { full, thumb };
}

/* ---------- Données ---------- */
function ensureSub() {
  const id = ctx.state.spaceId;
  if (!id || (unsub && spaceId === id)) return;
  stopPlaces();
  spaceId = id;
  unsub = store.subscribePlaces(id, {
    onPlaces: (p) => { data.places = p; data.loaded = true; data.error = false; update(); },
    onRatings: (r) => { data.ratings = r; update(); },
    onError: (e) => { console.error(e); data.error = true; update(); },
  });
}
export function stopPlaces() {
  if (unsub) { unsub(); unsub = null; }
  closeDetailSub();
  Object.assign(data, { places: [], ratings: [], loaded: false, error: false });
  ui.placeId = null; spaceId = null;
}
function closeDetailSub() {
  if (detail.unsub) detail.unsub();
  Object.assign(detail, { placeId: null, photos: [], unsub: null, loaded: false });
  detail.full.clear();
}
function openDetailSub(placeId) {
  if (detail.placeId === placeId) return;
  closeDetailSub();
  detail.placeId = placeId;
  detail.unsub = store.subscribePlacePhotos(ctx.state.spaceId, placeId, (ph) => {
    detail.photos = ph.sort((a, b) => tsOf(a.createdAt) - tsOf(b.createdAt));
    detail.loaded = true;
    update();
    if (viewer.open) renderViewer();
  }, (e) => { console.error(e); detail.loaded = true; update(); });
}
function update() { if (ctx.state.tab === "agenda" && ui.mode === "places") renderPlaces(); }

/* ---------- Mode Événements / Restos & bars ---------- */
function setMode(mode, quiet) {
  ui.mode = mode;
  try { localStorage.setItem(LS_MODE, mode); } catch { }
  document.querySelectorAll("#ag-mode [data-mode]").forEach(b => { b.classList.toggle("active", b.dataset.mode === mode); b.setAttribute("aria-pressed", b.dataset.mode === mode); });
  $("#ag-events").hidden = mode !== "events";
  $("#places-root").hidden = mode !== "places";
  if (quiet) return;
  if (mode === "places") renderPlaces(); else ctx.renderAgenda();
}
export const agendaMode = () => ui.mode;

/* ---------- Rendu ---------- */
export function renderPlaces() {
  if (!ctx || ui.mode !== "places") return;
  ensureSub();
  const root = $("#places-root");
  if (data.error) {
    root.innerHTML = `<div class="card"><p><strong>Les bonnes adresses ne sont pas encore activées.</strong></p>
      <p class="small muted">Les règles de sécurité Firestore doivent être mises à jour, puis l'app rouverte.</p></div>`;
    return;
  }
  if (ui.placeId) {
    const p = data.places.find(x => x.id === ui.placeId);
    if (p) { ui.justAdded = null; openDetailSub(p.id); root.innerHTML = detailHtml(p); return; }
    // Adresse tout juste créée : on attend qu'elle arrive de Firestore.
    if (ui.justAdded === ui.placeId) { root.innerHTML = `<p class="small muted">Chargement…</p>`; return; }
    if (data.loaded) { ui.placeId = null; closeDetailSub(); }
  }
  root.innerHTML = listHtml();
}

function listHtml() {
  const all = data.places;
  const cities = [...new Set(all.map(p => (p.city || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
  if (ui.city && !cities.includes(ui.city)) ui.city = "";
  let list = all.filter(p => (!ui.type || p.type === ui.type) && (!ui.city || (p.city || "").trim() === ui.city));
  const st = new Map(all.map(p => [p.id, statsOf(p.id)]));
  const d = (p) => (p.km == null ? 9999 : p.km);
  list.sort(ui.sort === "near"
    ? (a, b) => d(a) - d(b) || st.get(b.id).avg - st.get(a.id).avg
    : (a, b) => st.get(b.id).avg - st.get(a.id).avg || st.get(b.id).n - st.get(a.id).n || d(a) - d(b) || a.name.localeCompare(b.name, "fr"));
  const card = (p) => {
    const s = st.get(p.id);
    const cover = p.cover
      ? `<img src="${esc(p.cover)}" alt="" loading="lazy">`
      : `<span class="pl-initial" style="background:${colorFor(p.name)}" aria-hidden="true">${esc((p.name || "?").trim().charAt(0).toUpperCase())}</span>`;
    return `
      <button class="pl-card" data-act="open" data-id="${esc(p.id)}">
        <span class="pl-cover">${cover}</span>
        <span class="pl-line"><span class="pl-name">${esc(p.name)}</span>
          <span class="pl-score">${s.n ? `★ ${fmt1(s.avg)} <span class="muted">(${s.n})</span>` : `<span class="muted">Nouveau</span>`}</span></span>
        <span class="pl-sub">${esc(TYPES[p.type] || "Autre")}${p.city ? " · " + esc(p.city) : ""}</span>
        <span class="pl-sub">${[distLabel(p), price(p.price)].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</span>
      </button>`;
  };
  const typeOpts = `<option value="">Tous les types</option>` + Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${ui.type === k ? "selected" : ""}>${v}</option>`).join("");
  const cityOpts = `<option value="">Toutes les villes</option>` + cities.map(c => `<option ${ui.city === c ? "selected" : ""}>${esc(c)}</option>`).join("");
  return `
    <button class="btn btn-primary btn-block pl-add" data-act="add">+ Ajouter une adresse</button>
    ${all.length ? `
      <div class="segmented" role="group" aria-label="Trier les adresses">
        <button type="button" data-act="sort" data-sort="top" class="${ui.sort === "top" ? "active" : ""}" aria-pressed="${ui.sort === "top"}">Les mieux notés</button>
        <button type="button" data-act="sort" data-sort="near" class="${ui.sort === "near" ? "active" : ""}" aria-pressed="${ui.sort === "near"}">Les plus proches</button>
      </div>
      <div class="pl-filters">
        <select id="pl-type" aria-label="Filtrer par type">${typeOpts}</select>
        <select id="pl-city" aria-label="Filtrer par ville">${cityOpts}</select>
      </div>` : ""}
    ${!data.loaded ? `<p class="small muted">Chargement…</p>`
      : !all.length ? `<div class="ev-empty"><div class="ev-empty-emoji" aria-hidden="true">🍽️</div><p><strong>Aucune adresse pour l'instant.</strong></p><p class="muted">Ajoutez votre premier coup de cœur !</p></div>`
      : !list.length ? `<p class="small muted pl-none">Aucune adresse ne correspond à ces filtres.</p>`
      : `<div class="pl-grid">${list.map(card).join("")}</div>`}
    ${all.length ? `<p class="small muted ev-sources">Distances à vol d'oiseau depuis la maison d'Hasparren (≈ : centre de la ville). Localisation : © les contributeurs d'OpenStreetMap.</p>` : ""}`;
}

function detailHtml(p) {
  const s = statsOf(p.id);
  const meM = ctx.me();
  const mine = meM ? ratingsOf(p.id).find(r => r.memberId === meM.id) : null;
  const reviews = ratingsOf(p.id).sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt));
  const photos = detail.placeId === p.id ? detail.photos : [];
  const coverPh = photos.find(x => x.id === p.coverId);
  const heroSrc = (coverPh && detail.full.get(coverPh.id)) || p.cover;
  if (coverPh && !detail.full.has(coverPh.id)) loadFull(coverPh.id);
  const hero = heroSrc
    ? `<button class="pl-hero" data-act="view" data-id="${esc(p.coverId)}" aria-label="Voir les photos"><img src="${esc(heroSrc)}" alt="${esc(p.name)}"></button>`
    : `<div class="pl-hero pl-hero-empty" style="background:${colorFor(p.name)}"><span>${esc((p.name || "?").trim().charAt(0).toUpperCase())}</span></div>`;
  const sub = [TYPES[p.type] || "Autre", p.city, price(p.price)].filter(Boolean).map(esc).join(" · ");
  const up = ui.upload && ui.upload.placeId === p.id ? ui.upload : null;
  return `
    <button class="link-btn pl-back" data-act="back">‹ Toutes les adresses</button>
    <article class="pl-detail" id="pl-detail">
      ${hero}
      <h2 class="pl-title">${esc(p.name)}</h2>
      <p class="pl-detail-sub">${sub}</p>
      <p class="pl-detail-score">${s.n ? `<strong>${fmt1(s.avg)} ★</strong> · ${s.n} avis` : `<span class="muted">Pas encore d'avis</span>`}</p>
      ${p.intro ? `<p class="pl-intro">${esc(p.intro)}</p>` : ""}
      <div class="pl-where">
        ${p.km != null ? `<span>${esc(distLabel(p, true))}</span>` : ""}
        <a class="btn btn-small" href="${esc(mapsHref(p))}" target="_blank" rel="noopener">${isUrl(p.address) ? "Voir sur la carte ↗" : "Itinéraire ↗"}</a>
      </div>
      ${p.address && !isUrl(p.address) ? `<p class="small muted pl-address">${esc(p.address)}</p>` : ""}
      <p class="small muted pl-author">Ajoutée par ${esc(authorOf(p))}${dateOf(p.createdAt) ? " le " + esc(dateOf(p.createdAt)) : ""}</p>

      <section class="memo-section" id="pl-photos-zone">
        <h3 class="memo-title">Photos${photos.length ? ` <span class="muted pl-count">${photos.length}</span>` : ""}</h3>
        ${photos.length ? `<div class="pl-gallery">${photos.map(ph => `
          <button class="pl-thumb" data-act="view" data-id="${esc(ph.id)}" aria-label="Voir la photo de ${esc(authorOf(ph))}">
            <img src="${esc(ph.thumb)}" alt="" loading="lazy">${ph.id === p.coverId ? `<span class="pl-cover-tag">Couverture</span>` : ""}
          </button>`).join("")}</div>`
          : `<p class="small muted memo-empty">${detail.loaded ? "Pas encore de photo." : "Chargement…"}</p>`}
        ${up ? `<div class="pl-upload" role="status">
            <div class="progress"><span style="width:${Math.round(up.done / up.steps * 100)}%"></span></div>
            <span class="progress-label">${esc(up.label)}</span></div>` : ""}
        <button class="btn btn-block pl-photo-btn" data-act="pick" ${up ? "disabled" : ""}>📷 Ajouter des photos</button>
        <p class="small muted pl-drop-hint">Sur ordinateur, vous pouvez aussi glisser des photos ici.</p>
      </section>

      <section class="memo-section">
        <h3 class="memo-title">Avis</h3>
        ${mine
          ? `<div class="pl-mine"><span>Votre note : ${starsHtml(mine.stars)}</span>
               <span><button class="link-btn" data-act="rate">Modifier</button><button class="link-btn danger" data-act="unrate">Retirer</button></span></div>`
          : `<button class="btn btn-block" data-act="rate">★ Donner mon avis</button>`}
        ${reviews.length ? `<ul class="pl-reviews">${reviews.map(r => `
          <li>
            <div class="pl-review-head"><strong>${esc(nameOf(r))}</strong>${starsHtml(r.stars)}<span class="small muted">${esc(dateOf(r.updatedAt))}</span></div>
            ${r.comment ? `<p class="pl-review-text">${esc(r.comment)}</p>` : ""}
          </li>`).join("")}</ul>` : `<p class="small muted memo-empty">Soyez le premier à donner votre avis.</p>`}
      </section>

      <div class="check-footer pl-actions">
        <button class="link-btn" data-act="edit">Modifier la fiche</button>
        <button class="link-btn danger" data-act="delete">Supprimer l'adresse</button>
      </div>
    </article>`;
}

async function loadFull(photoId) {
  if (detail.full.has(photoId)) return detail.full.get(photoId);
  detail.full.set(photoId, null);
  try {
    const d = await store.getPhotoFull(ctx.state.spaceId, photoId);
    detail.full.set(photoId, d);
    if (viewer.open && detail.photos[viewer.index]?.id === photoId) renderViewer();
    else if (d && ui.placeId) update();
    return d;
  } catch (e) { console.error(e); detail.full.delete(photoId); return null; }
}

/* ---------- Formulaire d'une adresse ---------- */
function placeSheet(p) {
  const editing = !!p;
  let pr = p ? (p.price || 0) : 0;
  ctx.openSheet(`
    <h3>${editing ? "Modifier l'adresse" : "Nouvelle adresse"}</h3>
    <form id="pl-form" autocomplete="off">
      <label class="label" for="pl-name">Nom</label>
      <input id="pl-name" maxlength="80" value="${esc(p?.name || "")}" placeholder="Ex. Chez Pantxika">
      <label class="label" for="pl-ftype">Type</label>
      <select id="pl-ftype">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${(p?.type || "resto") === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <label class="label" for="pl-fcity">Ville</label>
      <input id="pl-fcity" list="pl-cities" maxlength="60" value="${esc(p?.city || "")}" placeholder="Choisir ou saisir une ville">
      <datalist id="pl-cities">${Object.keys(CITIES).map(c => `<option value="${esc(c)}">`).join("")}</datalist>
      <label class="label" for="pl-addr">Lien Google Maps ou adresse <span class="muted">(facultatif)</span></label>
      <input id="pl-addr" maxlength="500" value="${esc(p?.address || "")}" placeholder="https://maps.app.goo.gl/… ou 12 rue…">
      <span class="label">Gamme de prix</span>
      <div class="segmented pl-price" role="group" aria-label="Gamme de prix">
        ${[1, 2, 3].map(n => `<button type="button" data-price="${n}" class="${pr === n ? "active" : ""}" aria-pressed="${pr === n}">${"€".repeat(n)}</button>`).join("")}
      </div>
      <label class="label" for="pl-intro">Un petit mot <span class="muted">(facultatif)</span></label>
      <textarea id="pl-intro" maxlength="600" rows="3" placeholder="Ce qu'on y aime, ce qu'il faut commander…">${esc(p?.intro || "")}</textarea>
      <p class="error" id="pl-error" hidden></p>
      <div class="btn-row">
        <button type="button" class="btn" id="pl-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary" id="pl-save">${editing ? "Enregistrer" : "Ajouter"}</button>
      </div>
    </form>`);
  document.querySelectorAll(".pl-price [data-price]").forEach(b => b.onclick = () => {
    const n = +b.dataset.price; pr = pr === n ? 0 : n;
    document.querySelectorAll(".pl-price [data-price]").forEach(x => { x.classList.toggle("active", +x.dataset.price === pr); x.setAttribute("aria-pressed", +x.dataset.price === pr); });
  });
  if (!editing) setTimeout(() => $("#pl-name").focus(), 100);
  $("#pl-cancel").onclick = () => ctx.closeSheet();
  $("#pl-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#pl-name").value.trim().slice(0, 80);
    if (!name) { const er = $("#pl-error"); er.textContent = "Indiquez le nom de l'adresse."; er.hidden = false; return; }
    const cityRaw = $("#pl-fcity").value.trim().slice(0, 60);
    const city = Object.keys(CITIES).find(k => k.toLowerCase() === cityRaw.toLowerCase()) || cityRaw;
    const fields = { name, type: $("#pl-ftype").value, city, address: $("#pl-addr").value.trim().slice(0, 500), price: pr, intro: $("#pl-intro").value.trim().slice(0, 600) };
    const btn = $("#pl-save"); btn.disabled = true; btn.textContent = "Enregistrement…";
    const sid = ctx.state.spaceId;
    try {
      // Une seule requête de géocodage, seulement si l'emplacement a changé.
      const moved = !editing || fields.address !== (p.address || "") || fields.city !== (p.city || "") || (!fields.address && fields.name !== p.name) || p.geo === "none";
      if (moved) {
        const g = await geocode(fields);
        Object.assign(fields, { lat: g.lat, lon: g.lon, geo: g.geo, km: kmFrom(g.lat, g.lon) });
      }
      if (editing) { await store.updatePlace(sid, p.id, fields); ctx.closeSheet(); return; }
      const meM = ctx.me();
      const id = await store.addPlace(sid, { ...fields, authorId: meM?.id || null, authorName: meM?.name || null });
      ctx.closeSheet();
      ui.placeId = id; ui.justAdded = id; renderPlaces(); window.scrollTo(0, 0);
      ctx.toast("Adresse ajoutée");
    } catch (ex) { btn.disabled = false; btn.textContent = editing ? "Enregistrer" : "Ajouter"; fail(ex); }
  };
}

/* ---------- Note ---------- */
function rateSheet(p) {
  const meM = ctx.me();
  if (!meM) {
    ctx.openSheet(`
      <h3>Qui êtes-vous ?</h3>
      <p>Pour donner votre avis, choisissez d'abord votre profil : la note sera enregistrée à votre nom.</p>
      <div class="btn-row"><button class="btn" id="rt-no">Annuler</button><button class="btn btn-primary" id="rt-who">Choisir mon profil</button></div>`);
    $("#rt-no").onclick = () => ctx.closeSheet();
    $("#rt-who").onclick = () => { ctx.closeSheet(); ctx.showWhoami(); };
    return;
  }
  const mine = ratingsOf(p.id).find(r => r.memberId === meM.id);
  let n = mine?.stars || 0;
  ctx.openSheet(`
    <h3>Votre avis</h3>
    <p class="muted pl-rate-for">${esc(p.name)}</p>
    <div class="pl-rate" role="radiogroup" aria-label="Note sur 5">
      ${[1, 2, 3, 4, 5].map(k => `<button type="button" role="radio" data-n="${k}" aria-label="${k} étoile${k > 1 ? "s" : ""}" aria-checked="${k === n}">★</button>`).join("")}
    </div>
    <p class="small muted pl-rate-label" id="rt-label"></p>
    <label class="label" for="rt-comment">Commentaire <span class="muted">(facultatif)</span></label>
    <textarea id="rt-comment" maxlength="500" rows="3" placeholder="Ce que vous avez aimé (ou pas)…">${esc(mine?.comment || "")}</textarea>
    <p class="error" id="rt-error" hidden></p>
    <div class="btn-row"><button class="btn" id="rt-cancel">Annuler</button><button class="btn btn-primary" id="rt-save">Enregistrer</button></div>`);
  const words = ["Touchez les étoiles pour noter", "Bof", "Correct", "Bien", "Très bien", "Coup de cœur !"];
  const paint = () => {
    document.querySelectorAll(".pl-rate [data-n]").forEach(b => { b.classList.toggle("on", +b.dataset.n <= n); b.setAttribute("aria-checked", +b.dataset.n === n); });
    $("#rt-label").textContent = words[n];
  };
  paint();
  document.querySelectorAll(".pl-rate [data-n]").forEach(b => b.onclick = () => { n = +b.dataset.n; $("#rt-error").hidden = true; paint(); });
  $("#rt-cancel").onclick = () => ctx.closeSheet();
  $("#rt-save").onclick = () => {
    if (!n) { const er = $("#rt-error"); er.textContent = "Choisissez une note de 1 à 5 étoiles."; er.hidden = false; return; }
    const comment = $("#rt-comment").value.trim().slice(0, 500);
    ctx.closeSheet();
    store.setRating(ctx.state.spaceId, { placeId: p.id, memberId: meM.id, memberName: meM.name, stars: n, comment })
      .then(() => ctx.toast(mine ? "Note modifiée" : "Merci pour votre avis !")).catch(fail);
  };
}

/* ---------- Envoi des photos ---------- */
async function uploadFiles(p, files) {
  files = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name));
  if (!files.length || ui.upload) return;
  const meM = ctx.me(), sid = ctx.state.spaceId;
  const steps = files.length * 2;
  ui.upload = { placeId: p.id, done: 0, steps, label: `Préparation de la photo 1 sur ${files.length}…` };
  const paint = () => {
    const bar = document.querySelector(".pl-upload .progress span"), lab = document.querySelector(".pl-upload .progress-label");
    if (bar) bar.style.width = Math.round(ui.upload.done / steps * 100) + "%";
    if (lab) lab.textContent = ui.upload.label;
  };
  renderPlaces();
  let hasCover = !!data.places.find(x => x.id === p.id)?.coverId, ok = 0, ko = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      ui.upload.label = `Préparation de la photo ${i + 1} sur ${files.length}…`; paint();
      const { full, thumb } = await compress(files[i]);
      ui.upload.done++; ui.upload.label = `Envoi de la photo ${i + 1} sur ${files.length}…`; paint();
      await store.addPhoto(sid, { placeId: p.id, thumb, full, authorId: meM?.id || null, authorName: meM?.name || null, setCover: !hasCover });
      hasCover = true; ok++;
    } catch (e) { console.error(e); ko++; ui.upload.done++; }
    ui.upload.done = (i + 1) * 2; paint();
  }
  ui.upload = null;
  renderPlaces();
  ctx.toast(ko ? `${ok} photo${ok > 1 ? "s" : ""} ajoutée${ok > 1 ? "s" : ""}, ${ko} impossible${ko > 1 ? "s" : ""} à lire` : `${ok} photo${ok > 1 ? "s" : ""} ajoutée${ok > 1 ? "s" : ""}`);
}

/* ---------- Visionneuse plein écran ---------- */
const viewer = { open: false, index: 0 };
function openViewer(photoId) {
  const k = detail.photos.findIndex(x => x.id === photoId);
  if (k < 0) return;
  viewer.open = true; viewer.index = k;
  $("#pl-viewer").hidden = false;
  document.body.style.overflow = "hidden";
  renderViewer();
}
function closeViewer() {
  viewer.open = false;
  $("#pl-viewer").hidden = true;
  $("#pl-viewer").innerHTML = "";
  document.body.style.overflow = "";
}
function go(delta) {
  const n = detail.photos.length; if (n < 2) return;
  viewer.index = (viewer.index + delta + n) % n; renderViewer();
}
function renderViewer() {
  const ph = detail.photos[viewer.index];
  const p = data.places.find(x => x.id === detail.placeId);
  if (!ph || !p) return closeViewer();
  const full = detail.full.get(ph.id);
  if (!full) loadFull(ph.id);
  [-1, 1].forEach(dk => { const o = detail.photos[(viewer.index + dk + detail.photos.length) % detail.photos.length]; if (o && !detail.full.has(o.id)) loadFull(o.id); });
  const n = detail.photos.length;
  $("#pl-viewer").innerHTML = `
    <div class="pv-top">
      <span class="pv-count">${viewer.index + 1} / ${n}</span>
      <button class="pv-btn" data-pv="close" aria-label="Fermer">✕</button>
    </div>
    <div class="pv-stage" id="pv-stage">
      <img class="${full ? "" : "pv-loading"}" src="${esc(full || ph.thumb)}" alt="Photo de ${esc(authorOf(ph))}" draggable="false">
      ${n > 1 ? `<button class="pv-nav pv-prev" data-pv="prev" aria-label="Photo précédente">‹</button><button class="pv-nav pv-next" data-pv="next" aria-label="Photo suivante">›</button>` : ""}
    </div>
    <div class="pv-bottom">
      <p class="pv-author">Photo de <strong>${esc(authorOf(ph))}</strong>${dateOf(ph.createdAt) ? " · " + esc(dateOf(ph.createdAt)) : ""}</p>
      <div class="pv-actions">
        ${ph.id === p.coverId ? `<span class="pv-chip">✓ Photo de couverture</span>` : `<button class="pv-chip" data-pv="cover">Mettre en couverture</button>`}
        <button class="pv-chip pv-danger" data-pv="delete">Supprimer</button>
      </div>
    </div>`;
}
function initViewer() {
  const el = document.createElement("div");
  el.id = "pl-viewer"; el.className = "pv"; el.hidden = true;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Photos");
  document.body.appendChild(el);
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pv]"); if (!b) return;
    const ph = detail.photos[viewer.index], sid = ctx.state.spaceId, pid = detail.placeId;
    switch (b.dataset.pv) {
      case "close": return closeViewer();
      case "prev": return go(-1);
      case "next": return go(1);
      case "cover": return store.setCover(sid, pid, ph).then(() => { ctx.toast("Nouvelle photo de couverture"); renderViewer(); }).catch(fail);
      case "delete": {
        closeViewer();
        if (!(await ctx.confirmBox("Supprimer cette photo ?", `Photo ajoutée par ${authorOf(ph)}. Elle sera supprimée pour toute la famille.`))) return openViewer(ph.id);
        const p = data.places.find(x => x.id === pid);
        const next = p?.coverId === ph.id ? (detail.photos.find(x => x.id !== ph.id) || null) : undefined;
        store.deletePhoto(sid, pid, ph.id, next).then(() => ctx.toast("Photo supprimée")).catch(fail);
      }
    }
  });
  // Balayage gauche / droite
  let x0 = null, y0 = 0;
  el.addEventListener("pointerdown", (e) => { if (e.target.closest(".pv-stage")) { x0 = e.clientX; y0 = e.clientY; } });
  el.addEventListener("pointerup", (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeViewer();
  });
  el.addEventListener("pointercancel", () => { x0 = null; });
  document.addEventListener("keydown", (e) => {
    if (!viewer.open) return;
    if (e.key === "Escape") closeViewer(); else if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1);
  });
}

/* ---------- Actions ---------- */
async function onClick(e) {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const p = data.places.find(x => x.id === (ui.placeId || b.dataset.id));
  switch (b.dataset.act) {
    case "add": return placeSheet(null);
    case "sort": ui.sort = b.dataset.sort; return renderPlaces();
    case "open": ui.placeId = b.dataset.id; renderPlaces(); return window.scrollTo(0, 0);
    case "back": ui.placeId = null; closeDetailSub(); renderPlaces(); return window.scrollTo(0, 0);
    case "edit": return p && placeSheet(p);
    case "delete": {
      if (!p) return;
      const n = statsOf(p.id).n, ph = detail.photos.length;
      const extra = [ph ? `${ph} photo${ph > 1 ? "s" : ""}` : "", n ? `${n} avis` : ""].filter(Boolean).join(" et ");
      if (!(await ctx.confirmBox("Supprimer cette adresse ?", `« ${p.name} »${extra ? ` sera supprimée avec ses ${extra}` : " sera supprimée"} pour toute la famille.`))) return;
      ui.placeId = null; closeDetailSub(); renderPlaces();
      return store.deletePlace(ctx.state.spaceId, p.id).then(() => ctx.toast("Adresse supprimée")).catch(fail);
    }
    case "rate": return p && rateSheet(p);
    case "unrate": {
      const meM = ctx.me(); if (!p || !meM) return;
      if (await ctx.confirmBox("Retirer votre note ?", `Votre avis sur « ${p.name} » sera supprimé.`, "Retirer"))
        store.deleteRating(ctx.state.spaceId, p.id, meM.id).then(() => ctx.toast("Note retirée")).catch(fail);
      return;
    }
    case "view": return openViewer(b.dataset.id);
    case "pick": { const f = $("#pl-files"); f.value = ""; return f.click(); }
  }
}

export function initPlaces(context) {
  ctx = context;
  try { if (localStorage.getItem(LS_MODE) === "places") ui.mode = "places"; } catch { }
  document.querySelectorAll("#ag-mode [data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  setMode(ui.mode, true);
  const root = $("#places-root");
  root.addEventListener("click", onClick);
  root.addEventListener("change", (e) => {
    if (e.target.id === "pl-type") { ui.type = e.target.value; renderPlaces(); }
    else if (e.target.id === "pl-city") { ui.city = e.target.value; renderPlaces(); }
  });
  // Sélecteur de photos hors de la fiche : il survit aux rafraîchissements pendant que la personne choisit.
  const input = document.createElement("input");
  Object.assign(input, { type: "file", id: "pl-files", accept: "image/*", multiple: true, hidden: true });
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const p = data.places.find(x => x.id === ui.placeId);
    if (p && input.files.length) uploadFiles(p, [...input.files]);
  });
  // Glisser-déposer de photos sur ordinateur (sur la fiche ouverte)
  root.addEventListener("dragover", (e) => { if (ui.placeId && e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); root.classList.add("pl-dragging"); } });
  root.addEventListener("dragleave", (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove("pl-dragging"); });
  root.addEventListener("drop", (e) => {
    root.classList.remove("pl-dragging");
    if (!ui.placeId || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const p = data.places.find(x => x.id === ui.placeId);
    if (p) uploadFiles(p, e.dataTransfer.files);
  });
  initViewer();
}
