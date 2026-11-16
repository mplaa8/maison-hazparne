// Onglet « Agenda » › « Album » : les photos de famille, rangées en 3 niveaux.
//   Années › Séjours (un album par séjour du planning, créé automatiquement) › Événements (facultatifs).
//   + l'album « Souvenirs d'autrefois » pour les photos sans séjour.
// Photos : même méthode gratuite que les Restos & bars (compression dans le navigateur, une photo par
// document Firestore, miniature à part). Tout est sous le chemin secret du planning, rien dans le dépôt.
//
// Droits : tout le monde ajoute ; chacun supprime, déplace ou légende ses propres photos ; seul l'auteur
// d'un événement le renomme ou le supprime ; le mode administrateur (Réglages) permet tout.
// Ces droits sont appliqués par l'app (il n'y a pas de comptes) : c'est un garde-fou familial.
import * as store from "./store.js";
import { compress } from "./places.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const SOUVENIRS = "souvenirs";
const MAX_PER_PERSON = 30;
const LS_ADMIN = "mh.admin";

let ctx = null;
const data = { albums: [], loaded: false, error: false };
const ui = { view: "years", year: null, albumId: null, eventId: null, upload: null };
const content = { albumId: null, events: [], photos: [], loaded: false };
let unsubAlbums = null, unsubContent = null, subSpace = null;
const thumbs = new Map(); // id → miniature (mosaïques des années)
const fulls = new Map();  // id → photo complète (visionneuse)
let adminHash = undefined; // empreinte du code administrateur (null : pas encore défini)

/* ---------- Utilitaires ---------- */
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const dm = (s) => { const d = parse(s); return `${d.getUTCDate()}${d.getUTCDate() === 1 ? "er" : ""} ${MONTHS[d.getUTCMonth()]}`; };
function rangeText(a, b) {
  if (!a) return "";
  if (!b || a === b) return `le ${dm(a)} ${a.slice(0, 4)}`;
  return `du ${dm(a)}${a.slice(0, 4) !== b.slice(0, 4) ? " " + a.slice(0, 4) : ""} au ${dm(b)} ${b.slice(0, 4)}`;
}
const tsMs = (t) => (t?.toMillis ? t.toMillis() : typeof t === "number" ? t : t?.seconds ? t.seconds * 1000 : Date.now());
function dayText(ms) { const d = new Date(ms); return `${d.getDate()}${d.getDate() === 1 ? "er" : ""} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
const photoTime = (p) => (p.takenAt ? Date.parse(p.takenAt) : tsMs(p.createdAt));
const byTime = (a, b) => photoTime(a) - photoTime(b);
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
const fmtN = (n) => n.toLocaleString("fr-FR");
const fail = (ex) => { console.error(ex); ctx.toast("Erreur d'enregistrement. Réessayez."); };
const nameOf = (id, fallback) => (id && ctx.memberById(id)?.name) || fallback || "Quelqu'un";
export const isAdmin = () => { try { return !!adminHash && localStorage.getItem(LS_ADMIN) === adminHash; } catch { return false; } };
const mine = (x) => isAdmin() || (!!x.authorId && x.authorId === ctx.me()?.id);

/** Titre automatique : « Juillet 2027 · Caro et Philippe » (personne du séjour + invités de la famille). */
function autoTitle(stay) {
  const d = parse(stay.start);
  const names = [stay.memberId, ...(Array.isArray(stay.guestIds) ? stay.guestIds : [])].map(id => ctx.memberById(id)?.name).filter(Boolean);
  const who = names.length > 1 ? names.slice(0, -1).join(", ") + " et " + names[names.length - 1] : (names[0] || "");
  return `${cap(MONTHS[d.getUTCMonth()])} ${d.getUTCFullYear()}${who ? " · " + who : ""}`;
}
const stayAlbumId = (stayId) => "stay_" + stayId;

/** Tous les albums : un par séjour (même sans document), les albums de séjours supprimés, les souvenirs. */
function allAlbums() {
  const docs = new Map(data.albums.map(a => [a.id, a]));
  const today = ctx.todayStr();
  const out = [];
  for (const s of ctx.state.stays) {
    const a = docs.get(stayAlbumId(s.id)) || {};
    if (s.start > today && !a.count) continue; // séjour à venir sans photo : pas encore d'album
    out.push({ ...a, id: stayAlbumId(s.id), kind: "stay", stay: s, title: a.title || autoTitle(s), autoTitle: autoTitle(s),
      start: s.start, end: s.end, year: s.start.slice(0, 4), count: a.count || 0, deleted: false });
  }
  for (const a of data.albums) {
    if (a.kind === "stay" && a.deleted && (a.count || 0) > 0 && !ctx.state.stays.some(s => stayAlbumId(s.id) === a.id)) {
      out.push({ ...a, title: a.title || a.autoTitle || "Séjour", count: a.count || 0 });
    }
  }
  return out;
}
function souvenirs() {
  const a = data.albums.find(x => x.id === SOUVENIRS) || {};
  return { ...a, id: SOUVENIRS, kind: "souvenirs", title: "Souvenirs d'autrefois", count: a.count || 0 };
}
function albumById(id) { return id === SOUVENIRS ? souvenirs() : allAlbums().find(a => a.id === id) || null; }
function albumBase(a) {
  if (a.kind === "souvenirs") return { kind: "souvenirs" };
  return { kind: "stay", stayId: a.stay?.id || a.stayId || a.id.slice(5), autoTitle: a.autoTitle || a.title, start: a.start, end: a.end, year: a.year };
}

/* ---------- Date de prise de vue (EXIF des JPEG) ---------- */
async function exifDate(file) {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off), len = buf.getUint16(off + 2);
      if (marker === 0xFFE1 && buf.getUint32(off + 4) === 0x45786966) { // « Exif »
        const t = off + 10, le = buf.getUint16(t) === 0x4949;
        const u16 = (o) => buf.getUint16(t + o, le), u32 = (o) => buf.getUint32(t + o, le);
        const str = (o, n) => { let s = ""; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(buf.getUint8(t + o + i)); return s; };
        const readIfd = (ifd) => {
          const out = {}; const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12, tag = u16(e);
            if (tag === 0x8769) out.exif = u32(e + 8);
            if (tag === 0x9003 || tag === 0x0132) out[tag] = str(u32(e + 8), u32(e + 4));
          }
          return out;
        };
        const ifd0 = readIfd(u32(4));
        const ex = ifd0.exif ? readIfd(ifd0.exif) : {};
        const raw = ex[0x9003] || ifd0[0x9003] || ifd0[0x0132];
        const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + len;
    }
  } catch { }
  return null;
}

/* ---------- Données ---------- */
function ensureSub() {
  const id = ctx.state.spaceId;
  if (!id || (unsubAlbums && subSpace === id)) return;
  stopAlbum();
  subSpace = id;
  unsubAlbums = store.subscribeAlbums(id, (list) => { data.albums = list; data.loaded = true; data.error = false; update(); },
    (e) => { console.error(e); data.error = true; update(); });
  store.getAdminHash(id).then(h => { adminHash = h; update(); }).catch(() => { });
}
export function stopAlbum() {
  if (unsubAlbums) { unsubAlbums(); unsubAlbums = null; }
  closeContent();
  Object.assign(data, { albums: [], loaded: false, error: false });
  Object.assign(ui, { view: "years", year: null, albumId: null, eventId: null });
  thumbs.clear(); fulls.clear(); subSpace = null; adminHash = undefined;
}
function closeContent() {
  if (unsubContent) { unsubContent(); unsubContent = null; }
  Object.assign(content, { albumId: null, events: [], photos: [], loaded: false });
}
function openContent(albumId) {
  if (content.albumId === albumId) return;
  closeContent();
  content.albumId = albumId;
  unsubContent = store.subscribeAlbumContent(ctx.state.spaceId, albumId, {
    onEvents: (e) => { content.events = e; update(); },
    onPhotos: (p) => { content.photos = p; content.loaded = true; p.forEach(x => thumbs.set(x.id, x.thumb)); update(); if (viewer.open) renderViewer(); },
    onError: (e) => { console.error(e); content.loaded = true; update(); },
  });
}
const visible = () => ctx.state.tab === "agenda" && ctx.agendaMode() === "album";
function update() { if (visible()) renderAlbum(); }

/* ---------- Rendu ---------- */
export function renderAlbum() {
  if (!ctx || !visible()) return;
  ensureSub();
  const root = $("#album-root");
  if (data.error) {
    root.innerHTML = `<div class="card"><p><strong>L'album n'est pas encore activé.</strong></p>
      <p class="small muted">Les règles de sécurité Firestore doivent être mises à jour, puis l'app rouverte.</p></div>`;
    return;
  }
  if (ui.view === "event" || ui.view === "album") {
    const a = albumById(ui.albumId);
    if (!a) { Object.assign(ui, { view: ui.year ? "year" : "years", albumId: null, eventId: null }); closeContent(); }
    else {
      openContent(a.id);
      if (ui.view === "event") {
        const ev = content.events.find(e => e.id === ui.eventId);
        if (ev) { ui.newEvent = null; root.innerHTML = eventHtml(a, ev); return; }
        // Événement tout juste créé : on attend qu'il arrive de Firestore.
        if (content.loaded && ui.newEvent !== ui.eventId) ui.view = "album"; else { root.innerHTML = `<p class="small muted">Chargement…</p>`; return; }
      }
      root.innerHTML = albumHtml(a); return;
    }
  }
  closeContent();
  root.innerHTML = ui.view === "year" ? yearHtml(ui.year) : yearsHtml();
}

function mosaic(ids, label) {
  const cells = [0, 1, 2, 3].map(i => {
    const id = ids[i], t = id && thumbs.get(id);
    if (id && !thumbs.has(id)) loadThumb(id);
    return t ? `<span class="al-tile"><img src="${esc(t)}" alt="" loading="lazy"></span>` : `<span class="al-tile al-tile-empty"></span>`;
  }).join("");
  return `<span class="al-mosaic" aria-hidden="true">${cells}</span>${label || ""}`;
}
function loadThumb(id) {
  thumbs.set(id, null);
  store.getAlbumThumb(ctx.state.spaceId, id).then(t => { if (t) { thumbs.set(id, t); update(); } }).catch(() => thumbs.delete(id));
}
/** Jusqu'à 4 photos pour la mosaïque : couvertures d'abord, puis les premières photos des albums. */
function mosaicIds(albums) {
  const ids = [];
  const sorted = [...albums].sort((a, b) => (b.count || 0) - (a.count || 0));
  for (const a of sorted) if (a.coverId) { ids.push(a.coverId); if (a.cover) thumbs.set(a.coverId, a.cover); }
  for (const a of sorted) for (const p of (a.previews || [])) if (!ids.includes(p)) ids.push(p);
  return ids.slice(0, 4);
}

function yearsHtml() {
  const albums = allAlbums();
  const years = [...new Set(albums.map(a => a.year))].sort((a, b) => b.localeCompare(a));
  const sv = souvenirs();
  const card = (key, title, sub, ids) => `
    <button class="al-year" data-act="${key === SOUVENIRS ? "open-album" : "open-year"}" data-id="${esc(key)}">
      ${mosaic(ids)}
      <span class="al-year-text"><span class="al-year-title">${esc(title)}</span><span class="al-year-sub">${esc(sub)}</span></span>
    </button>`;
  return `<div class="al-years">
    ${card(SOUVENIRS, sv.title, sv.count ? plural(sv.count, "photo") : "Photos scannées et vieux albums", mosaicIds([sv]))}
    ${!data.loaded ? `<p class="small muted">Chargement…</p>` : years.length ? years.map(y => {
      const list = albums.filter(a => a.year === y), n = list.reduce((s, a) => s + (a.count || 0), 0);
      return card(y, y, `${plural(n, "photo")} · ${plural(list.length, "séjour")}`, mosaicIds(list));
    }).join("") : `<div class="ev-empty"><div class="ev-empty-emoji" aria-hidden="true">📷</div><p><strong>Pas encore d'album.</strong></p><p class="muted">Chaque séjour du planning devient un album dès son arrivée.</p></div>`}</div>`;
}

function yearHtml(y) {
  const list = allAlbums().filter(a => a.year === y).sort((a, b) => b.start.localeCompare(a.start));
  const full = list.filter(a => a.count > 0), empty = list.filter(a => !a.count);
  return `
    <button class="link-btn pl-back" data-act="back-years">‹ Toutes les années</button>
    <h2 class="pl-title">${esc(y)}</h2>
    ${full.length ? `<div class="al-albums">${full.map(a => `
      <button class="al-album" data-act="open-album" data-id="${esc(a.id)}">
        <span class="al-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : ""}</span>
        <span class="al-album-title">${esc(a.title)}</span>
        <span class="al-album-sub">${esc(rangeText(a.start, a.end))} · ${plural(a.count, "photo")}${a.deleted ? ` · <em class="al-deleted">séjour supprimé</em>` : ""}</span>
      </button>`).join("")}</div>` : ""}
    ${empty.length ? `<h3 class="al-sub-title">${full.length ? "Séjours sans photo" : "Séjours"}</h3>
      <ul class="al-empty-list">${empty.map(a => `
        <li><span><span class="al-empty-title">${esc(a.title)}</span><span class="small muted">${esc(rangeText(a.start, a.end))}</span></span>
        <button class="btn btn-small" data-act="first-photos" data-id="${esc(a.id)}">Ajouter les premières photos</button></li>`).join("")}</ul>` : ""}`;
}

function grid(photos) {
  return `<div class="pl-gallery al-grid">${photos.map(p => `
    <button class="pl-thumb" data-act="view" data-id="${esc(p.id)}" aria-label="Photo de ${esc(nameOf(p.authorId, p.authorName))}${p.caption ? " : " + esc(p.caption) : ""}">
      <img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async">
    </button>`).join("")}</div>`;
}
function uploadBar() {
  const up = ui.upload;
  if (!up || up.albumId !== ui.albumId || (up.eventId || null) !== (ui.view === "event" ? ui.eventId : null)) return "";
  return `<div class="pl-upload" role="status"><div class="progress"><span style="width:${Math.round(up.done / up.steps * 100)}%"></span></div><span class="progress-label">${esc(up.label)}</span></div>`;
}
function addButton(label = "📷 Ajouter des photos") {
  if (!navigator.onLine) return `<button class="btn btn-block pl-photo-btn" disabled>Connexion nécessaire pour envoyer des photos</button>`;
  return `<button class="btn btn-primary btn-block al-add" data-act="pick" ${ui.upload ? "disabled" : ""}>${label}</button>`;
}

function albumHtml(a) {
  const isStay = a.kind === "stay";
  const evs = [...content.events].sort((x, y) => (x.date || "").localeCompare(y.date || "") || tsMs(x.createdAt) - tsMs(y.createdAt));
  const loose = content.photos.filter(p => !p.eventId || !evs.some(e => e.id === p.eventId)).sort(byTime);
  const evCover = (e) => e.cover || content.photos.filter(p => p.eventId === e.id).sort(byTime)[0]?.thumb || null;
  return `
    <button class="link-btn pl-back" data-act="${isStay ? "back-year" : "back-years"}">‹ ${isStay ? esc(a.year) : "Toutes les années"}</button>
    <div class="al-head">
      <h2 class="pl-title">${esc(a.title)}</h2>
      <button class="icon-btn small-icon" data-act="rename-album" aria-label="Modifier le titre">✎</button>
    </div>
    <p class="pl-detail-sub">${isStay ? esc(rangeText(a.start, a.end)) + " · " : ""}${plural(content.loaded ? content.photos.length : a.count, "photo")}${a.deleted ? ` · <em class="al-deleted">séjour supprimé</em>` : ""}</p>
    ${!isStay ? `<p class="small muted al-intro">Pour les photos qui ne correspondent à aucun séjour : photos scannées, vieux albums…</p>` : ""}
    <div class="al-actions">${addButton()}<button class="btn btn-block" data-act="new-event">+ Créer un événement</button></div>
    ${uploadBar()}
    ${evs.length ? `<h3 class="memo-title al-section">Événements</h3><div class="al-events">${evs.map(e => {
      const c = evCover(e);
      return `<button class="al-event" data-act="open-event" data-id="${esc(e.id)}">
        <span class="al-cover">${c ? `<img src="${esc(c)}" alt="" loading="lazy">` : `<span class="al-event-empty" aria-hidden="true">✦</span>`}</span>
        <span class="al-album-title">${esc(e.title)}</span>
        <span class="al-album-sub">${e.date ? esc(dm(e.date)) + " · " : ""}${plural(content.photos.filter(p => p.eventId === e.id).length, "photo")}</span>
      </button>`;
    }).join("")}</div>` : ""}
    <h3 class="memo-title al-section">${evs.length ? (isStay ? "Autres photos du séjour" : "Autres photos") : "Photos"}${loose.length ? ` <span class="muted pl-count">${loose.length}</span>` : ""}</h3>
    ${!content.loaded ? `<p class="small muted">Chargement…</p>` : loose.length ? grid(loose) : `<p class="small muted memo-empty">${evs.length ? "Toutes les photos sont rangées dans les événements." : "Pas encore de photo."}</p>`}`;
}

function eventHtml(a, e) {
  const photos = content.photos.filter(p => p.eventId === e.id).sort(byTime);
  return `
    <button class="link-btn pl-back" data-act="back-album">‹ ${esc(a.title)}</button>
    <h2 class="pl-title">${esc(e.title)}</h2>
    <p class="pl-detail-sub">${e.date ? esc(dm(e.date)) + " " + e.date.slice(0, 4) + " · " : ""}${plural(photos.length, "photo")} · créé par ${esc(nameOf(e.authorId, e.authorName))}</p>
    <div class="al-actions">${addButton()}</div>
    ${uploadBar()}
    ${!content.loaded ? `<p class="small muted">Chargement…</p>` : photos.length ? grid(photos) : `<p class="small muted memo-empty">Pas encore de photo dans cet événement.</p>`}
    ${mine(e) ? `<div class="check-footer pl-actions"><button class="link-btn" data-act="edit-event">Modifier l'événement</button><button class="link-btn danger" data-act="delete-event">Supprimer l'événement</button></div>` : ""}`;
}

/* ---------- Formulaires ---------- */
function textSheet(title, label, value, ok, max, onOk) {
  ctx.openSheet(`
    <h3>${esc(title)}</h3>
    <form id="al-form" autocomplete="off">
      <label class="label" for="al-input">${esc(label)}</label>
      <input id="al-input" maxlength="${max}" value="${esc(value || "")}">
      <p class="error" id="al-error" hidden></p>
      <div class="btn-row"><button type="button" class="btn" id="al-cancel">Annuler</button><button type="submit" class="btn btn-primary">${esc(ok)}</button></div>
    </form>`);
  setTimeout(() => $("#al-input")?.focus(), 100);
  $("#al-cancel").onclick = () => ctx.closeSheet();
  $("#al-form").onsubmit = (ev) => { ev.preventDefault(); onOk($("#al-input").value.trim().slice(0, max)); };
}
function eventSheet(a, e) {
  const isStay = a.kind === "stay";
  const days = [];
  if (isStay) for (let d = a.start; d <= a.end && days.length < 400; d = new Date(parse(d).getTime() + 864e5).toISOString().slice(0, 10)) days.push(d);
  const cur = e?.date || (isStay ? (days.includes(ctx.todayStr()) ? ctx.todayStr() : days[0]) : "");
  ctx.openSheet(`
    <h3>${e ? "Modifier l'événement" : "Nouvel événement"}</h3>
    <form id="al-form" autocomplete="off">
      <label class="label" for="al-input">Titre</label>
      <input id="al-input" maxlength="80" value="${esc(e?.title || "")}" placeholder="Ex. Fêtes de Bayonne, Anniversaire de Léa">
      <label class="label" for="al-date">Date</label>
      ${isStay ? `<select id="al-date">${days.map(d => `<option value="${d}" ${d === cur ? "selected" : ""}>${esc(cap(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(parse(d))))}</option>`).join("")}</select>`
        : `<input type="date" id="al-date" value="${esc(cur)}">`}
      <p class="error" id="al-error" hidden></p>
      <div class="btn-row"><button type="button" class="btn" id="al-cancel">Annuler</button><button type="submit" class="btn btn-primary">${e ? "Enregistrer" : "Créer"}</button></div>
    </form>`);
  if (!e) setTimeout(() => $("#al-input")?.focus(), 100);
  $("#al-cancel").onclick = () => ctx.closeSheet();
  $("#al-form").onsubmit = (ev) => {
    ev.preventDefault();
    const title = $("#al-input").value.trim().slice(0, 80), date = $("#al-date").value || null;
    if (!title) { const er = $("#al-error"); er.textContent = "Donnez un titre à l'événement."; er.hidden = false; return; }
    const sid = ctx.state.spaceId, meM = ctx.me();
    ctx.closeSheet();
    if (e) return store.updateAlbumEvent(sid, e.id, { title, date }).catch(fail);
    const { id, done } = store.addAlbumEvent(sid, a.id, albumBase(a), { title, date, authorId: meM?.id || null, authorName: meM?.name || null });
    done.catch(fail);
    Object.assign(ui, { view: "event", eventId: id, newEvent: id }); renderAlbum(); window.scrollTo(0, 0);
    ctx.toast("Événement créé");
  };
}
function needProfile(what) {
  ctx.openSheet(`
    <h3>Qui êtes-vous ?</h3>
    <p>Pour ${what}, choisissez d'abord votre profil : vos photos seront enregistrées à votre nom.</p>
    <div class="btn-row"><button class="btn" id="al-no">Annuler</button><button class="btn btn-primary" id="al-who">Choisir mon profil</button></div>`);
  $("#al-no").onclick = () => ctx.closeSheet();
  $("#al-who").onclick = () => { ctx.closeSheet(); ctx.showWhoami(); };
}

/* ---------- Envoi des photos ---------- */
let pickTarget = null;
function pick(albumId, eventId) {
  if (!ctx.me()) return needProfile("ajouter des photos");
  if (!navigator.onLine) return ctx.toast("Connexion nécessaire pour envoyer des photos");
  pickTarget = { albumId, eventId: eventId || null };
  const f = $("#al-files"); f.value = ""; f.click();
}
async function uploadFiles(files) {
  const target = pickTarget; pickTarget = null;
  const a = target && albumById(target.albumId);
  files = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name));
  if (!a || !files.length || ui.upload) return;
  const meM = ctx.me(), sid = ctx.state.spaceId;
  // Les photos déjà dans l'album (pour les doublons et la limite) : on attend leur chargement.
  if (content.albumId !== a.id) openContent(a.id);
  for (let i = 0; i < 30 && !content.loaded; i++) await new Promise(r => setTimeout(r, 100));
  const notes = [];
  // Doublons : même taille de fichier et même date de prise de vue.
  const meta = await Promise.all(files.map(async f => ({ f, takenAt: await exifDate(f), size: f.size })));
  const keys = new Set(content.photos.map(p => `${p.srcSize}|${p.takenAt || ""}`));
  const fresh = [];
  for (const m of meta) { const k = `${m.size}|${m.takenAt || ""}`; if (keys.has(k)) continue; keys.add(k); fresh.push(m); }
  const dup = meta.length - fresh.length;
  if (dup) notes.push(`${plural(dup, "doublon")} ignoré${dup > 1 ? "s" : ""}`);
  // Limite : 30 photos par personne et par séjour.
  let list = fresh;
  if (a.kind === "stay") {
    const left = Math.max(0, MAX_PER_PERSON - content.photos.filter(p => p.authorId === meM.id).length);
    if (list.length > left) {
      list = list.slice(0, left);
      ctx.openSheet(`<h3>Gardez vos ${MAX_PER_PERSON} plus belles !</h3>
        <p>Chacun peut mettre jusqu'à ${MAX_PER_PERSON} photos par séjour, pour que l'album reste agréable à parcourir (et que la place gratuite dure longtemps).</p>
        <p class="muted">${left ? `Les ${plural(left, "première")} de votre sélection vont être ajoutées.` : "Vous avez déjà mis vos 30 photos dans ce séjour : supprimez-en une pour en ajouter une autre."}</p>
        <button class="btn btn-primary btn-block" id="al-ok">D'accord</button>`);
      $("#al-ok").onclick = () => ctx.closeSheet();
    }
  }
  if (!list.length) { if (dup) ctx.toast(notes.join(" · ")); return; }
  const steps = list.length * 2;
  ui.upload = { albumId: a.id, eventId: target.eventId, done: 0, steps, label: `Préparation de la photo 1 sur ${list.length}…` };
  const paint = () => {
    const bar = document.querySelector("#album-root .pl-upload .progress span"), lab = document.querySelector("#album-root .pl-upload .progress-label");
    if (bar) bar.style.width = Math.round(ui.upload.done / steps * 100) + "%";
    if (lab) lab.textContent = ui.upload.label;
  };
  renderAlbum();
  const doc = data.albums.find(x => x.id === a.id) || {};
  let hasCover = !!doc.coverId, previews = (doc.previews || []).length;
  const ev = target.eventId && content.events.find(e => e.id === target.eventId);
  let evCover = !!ev?.coverId, ok = 0, ko = 0;
  for (let i = 0; i < list.length; i++) {
    try {
      ui.upload.label = `Préparation de la photo ${i + 1} sur ${list.length}…`; paint();
      const { full, thumb } = await compress(list[i].f);
      ui.upload.done++; ui.upload.label = `Envoi de la photo ${i + 1} sur ${list.length}…`; paint();
      const { done } = store.addAlbumPhoto(sid, { albumId: a.id, eventId: target.eventId, thumb, full, authorId: meM.id, authorName: meM.name,
        takenAt: list[i].takenAt, srcSize: list[i].size }, { albumBase: albumBase(a), albumCover: !hasCover, preview: previews < 4, eventCover: !!target.eventId && !evCover });
      await done;
      hasCover = true; evCover = true; previews++; ok++;
    } catch (e) { console.error(e); ko++; }
    ui.upload.done = (i + 1) * 2; paint();
  }
  ui.upload = null;
  renderAlbum();
  notes.unshift(`${plural(ok, "photo")} ajoutée${ok > 1 ? "s" : ""}`);
  if (ko) notes.push(`${ko} impossible${ko > 1 ? "s" : ""} à lire`);
  ctx.toast(notes.join(" · "));
}

/* ---------- Visionneuse ---------- */
const viewer = { open: false, ids: [], index: 0 };
function scopePhotos() {
  const evIds = new Set(content.events.map(e => e.id));
  const list = ui.view === "event" ? content.photos.filter(p => p.eventId === ui.eventId) : content.photos.filter(p => !p.eventId || !evIds.has(p.eventId));
  return list.sort(byTime);
}
function openViewer(photoId) {
  const list = scopePhotos();
  viewer.ids = list.map(p => p.id); viewer.index = Math.max(0, viewer.ids.indexOf(photoId)); viewer.open = true;
  $("#al-viewer").hidden = false; document.body.style.overflow = "hidden";
  renderViewer();
}
function closeViewer() { viewer.open = false; $("#al-viewer").hidden = true; $("#al-viewer").innerHTML = ""; document.body.style.overflow = ""; }
function go(d) { const n = viewer.ids.length; if (n < 2) return; viewer.index = (viewer.index + d + n) % n; renderViewer(); }
function loadFull(id) {
  if (fulls.has(id)) return;
  fulls.set(id, null);
  store.getAlbumFull(ctx.state.spaceId, id).then(d => { fulls.set(id, d); if (viewer.open && viewer.ids[viewer.index] === id) renderViewer(); }).catch(() => fulls.delete(id));
}
function renderViewer() {
  // La liste suit les changements (photo supprimée ou déplacée par quelqu'un d'autre).
  const cur = viewer.ids[viewer.index];
  viewer.ids = scopePhotos().map(p => p.id);
  if (!viewer.ids.length) return closeViewer();
  if (viewer.ids.includes(cur)) viewer.index = viewer.ids.indexOf(cur); else viewer.index = Math.min(viewer.index, viewer.ids.length - 1);
  const p = content.photos.find(x => x.id === viewer.ids[viewer.index]);
  const a = albumById(ui.albumId), ev = ui.view === "event" ? content.events.find(e => e.id === ui.eventId) : null;
  const full = fulls.get(p.id);
  if (!full) loadFull(p.id);
  [-1, 1].forEach(k => { const o = viewer.ids[(viewer.index + k + viewer.ids.length) % viewer.ids.length]; if (o) loadFull(o); });
  const isCover = ev ? ev.coverId === p.id : a?.coverId === p.id;
  const n = viewer.ids.length;
  const when = p.takenAt ? `prise le ${dayText(Date.parse(p.takenAt))}` : `ajoutée le ${dayText(tsMs(p.createdAt))}`;
  $("#al-viewer").innerHTML = `
    <div class="pv-top"><span class="pv-count">${viewer.index + 1} / ${n}</span><button class="pv-btn" data-pv="close" aria-label="Fermer">✕</button></div>
    <div class="pv-stage">
      <img class="${full ? "" : "pv-loading"}" src="${esc(full || p.thumb)}" alt="${esc(p.caption || "Photo de " + nameOf(p.authorId, p.authorName))}" draggable="false">
      ${n > 1 ? `<button class="pv-nav pv-prev" data-pv="prev" aria-label="Photo précédente">‹</button><button class="pv-nav pv-next" data-pv="next" aria-label="Photo suivante">›</button>` : ""}
    </div>
    <div class="pv-bottom">
      ${!full && !navigator.onLine ? `<p class="pv-offline">Hors connexion : aperçu réduit, la photo complète s'affichera au retour du réseau.</p>` : ""}
      ${p.caption ? `<p class="pv-caption">${esc(p.caption)}</p>` : ""}
      <p class="pv-author">Photo de <strong>${esc(nameOf(p.authorId, p.authorName))}</strong> · ${esc(when)}</p>
      <div class="pv-actions">
        ${isCover ? `<span class="pv-chip">✓ Couverture</span>` : `<button class="pv-chip" data-pv="cover">Mettre en couverture</button>`}
        ${mine(p) ? `<button class="pv-chip" data-pv="caption">${p.caption ? "Modifier la légende" : "Légende"}</button>
          ${content.events.length ? `<button class="pv-chip" data-pv="move">Déplacer</button>` : ""}
          <button class="pv-chip pv-danger" data-pv="delete">Supprimer</button>` : ""}
      </div>
    </div>`;
}
function nextCover(list, removedId) { const o = list.filter(x => x.id !== removedId).sort(byTime)[0]; return o ? { id: o.id, thumb: o.thumb } : null; }
async function viewerAction(act) {
  const p = content.photos.find(x => x.id === viewer.ids[viewer.index]); if (!p) return;
  const sid = ctx.state.spaceId, a = albumById(ui.albumId);
  if (act === "cover") {
    const ev = ui.view === "event" ? content.events.find(e => e.id === ui.eventId) : null;
    (ev ? store.updateAlbumEvent(sid, ev.id, { coverId: p.id, cover: p.thumb }) : store.saveAlbum(sid, a.id, { ...albumBase(a), coverId: p.id, cover: p.thumb }))
      .then(() => ctx.toast(ev ? "Couverture de l'événement" : "Couverture de l'album")).catch(fail);
    return;
  }
  if (act === "caption") {
    closeViewer();
    return textSheet("Légende", "Légende de la photo (facultatif)", p.caption, "Enregistrer", 200, (v) => {
      ctx.closeSheet(); store.updateAlbumPhoto(sid, p.id, { caption: v }).catch(fail); openViewer(p.id);
    });
  }
  if (act === "move") {
    closeViewer();
    const opts = [{ id: "", label: a.kind === "stay" ? "Photos du séjour (aucun événement)" : "Autres photos (aucun événement)" },
      ...content.events.map(e => ({ id: e.id, label: e.title + (e.date ? " · " + dm(e.date) : "") }))];
    ctx.openSheet(`<h3>Déplacer la photo</h3>
      <div class="al-move">${opts.map(o => `<button class="btn btn-block ${o.id === (p.eventId || "") ? "btn-primary" : ""}" data-move="${esc(o.id)}">${esc(o.label)}</button>`).join("")}</div>
      <button class="btn btn-ghost btn-block" id="al-cancel">Annuler</button>`);
    $("#al-cancel").onclick = () => ctx.closeSheet();
    document.querySelectorAll("[data-move]").forEach(b => b.onclick = () => {
      const to = b.dataset.move || null; ctx.closeSheet();
      if (to === (p.eventId || null)) return;
      const from = p.eventId && content.events.find(e => e.id === p.eventId), dest = to && content.events.find(e => e.id === to);
      store.moveAlbumPhoto(sid, p, to, {
        fromEventCover: from && from.coverId === p.id ? nextCover(content.photos.filter(x => x.eventId === from.id), p.id) : undefined,
        toEventCover: !!dest && !dest.coverId,
      }).then(() => ctx.toast(to ? `Photo rangée dans « ${dest.title} »` : "Photo remise dans le séjour")).catch(fail);
    });
    return;
  }
  if (act === "delete") {
    closeViewer();
    if (!(await ctx.confirmBox("Supprimer cette photo ?", `Photo ajoutée par ${nameOf(p.authorId, p.authorName)}. Elle sera supprimée pour toute la famille.`))) return openViewer(p.id);
    const ev = p.eventId && content.events.find(e => e.id === p.eventId);
    store.deleteAlbumPhoto(sid, p, {
      albumCover: a.coverId === p.id ? nextCover(content.photos, p.id) : undefined,
      eventCover: ev && ev.coverId === p.id ? nextCover(content.photos.filter(x => x.eventId === ev.id), p.id) : undefined,
    }).then(() => ctx.toast("Photo supprimée")).catch(fail);
  }
}
function initViewer() {
  const el = document.createElement("div");
  el.id = "al-viewer"; el.className = "pv"; el.hidden = true;
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Photos de l'album");
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv]"); if (!b) return;
    if (b.dataset.pv === "close") return closeViewer();
    if (b.dataset.pv === "prev") return go(-1);
    if (b.dataset.pv === "next") return go(1);
    viewerAction(b.dataset.pv);
  });
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
  const id = b.dataset.id, sid = ctx.state.spaceId;
  const top = () => window.scrollTo(0, 0);
  switch (b.dataset.act) {
    case "open-year": Object.assign(ui, { view: "year", year: id }); renderAlbum(); return top();
    case "open-album": Object.assign(ui, { view: "album", albumId: id, eventId: null }); if (id === SOUVENIRS) ui.year = null; renderAlbum(); return top();
    case "first-photos": Object.assign(ui, { view: "album", albumId: id, eventId: null }); renderAlbum(); top(); return pick(id, null);
    case "open-event": Object.assign(ui, { view: "event", eventId: id }); renderAlbum(); return top();
    case "back-years": Object.assign(ui, { view: "years", year: null, albumId: null, eventId: null }); renderAlbum(); return top();
    case "back-year": Object.assign(ui, { view: "year", albumId: null, eventId: null }); renderAlbum(); return top();
    case "back-album": Object.assign(ui, { view: "album", eventId: null }); renderAlbum(); return top();
    case "pick": return pick(ui.albumId, ui.view === "event" ? ui.eventId : null);
    case "view": return openViewer(id);
    case "new-event": return eventSheet(albumById(ui.albumId), null);
    case "rename-album": {
      const a = albumById(ui.albumId); if (!a) return;
      return textSheet("Titre de l'album", a.kind === "stay" ? `Titre (vide = « ${a.autoTitle} »)` : "Titre", a.kind === "stay" && a.title === a.autoTitle ? "" : a.title, "Enregistrer", 80, (v) => {
        ctx.closeSheet(); store.saveAlbum(sid, a.id, { ...albumBase(a), title: v || null }).catch(fail);
      });
    }
    case "edit-event": { const ev = content.events.find(x => x.id === ui.eventId); return ev && mine(ev) && eventSheet(albumById(ui.albumId), ev); }
    case "delete-event": {
      const ev = content.events.find(x => x.id === ui.eventId); if (!ev || !mine(ev)) return;
      const ph = content.photos.filter(p => p.eventId === ev.id);
      if (!(await ctx.confirmBox("Supprimer l'événement ?", `« ${ev.title} » sera supprimé.${ph.length === 1 ? " Sa photo reste dans l'album." : ph.length ? ` Ses ${ph.length} photos restent dans l'album.` : ""}`))) return;
      Object.assign(ui, { view: "album", eventId: null }); renderAlbum();
      return store.deleteAlbumEvent(sid, ev.id, ph.map(p => p.id)).then(() => ctx.toast("Événement supprimé")).catch(fail);
    }
  }
}

/* ---------- Séjour supprimé ---------- */
/** Avant de supprimer un séjour : s'il a des photos, demande s'il faut les garder. Renvoie false pour annuler. */
export async function beforeStayDelete(stay) {
  const sid = ctx.state.spaceId, id = stayAlbumId(stay.id);
  let a = null;
  try { a = await store.getAlbum(sid, id); } catch { }
  const n = a?.count || 0;
  if (!n) { if (a) store.deleteAlbumAll(sid, id).catch(() => { }); return true; }
  return new Promise((resolve) => {
    let done = false;
    ctx.openSheet(`
      <h3>Ce séjour contient ${plural(n, "photo")}</h3>
      <p>Les garder dans l'album ? L'album restera, marqué « séjour supprimé ».</p>
      <button class="btn btn-primary btn-block" id="sd-keep">Garder les photos</button>
      <button class="btn btn-danger-ghost btn-block" id="sd-all" style="margin-top:10px">Tout supprimer (séjour et photos)</button>
      <button class="btn btn-ghost btn-block" id="sd-cancel">Annuler</button>`, () => { if (!done) resolve(false); });
    $("#sd-cancel").onclick = () => { done = true; ctx.closeSheet(); resolve(false); };
    $("#sd-keep").onclick = () => {
      done = true; ctx.closeSheet();
      const al = albumById(id) || {};
      store.saveAlbum(sid, id, { kind: "stay", stayId: stay.id, deleted: true, autoTitle: al.autoTitle || autoTitle(stay), start: stay.start, end: stay.end, year: stay.start.slice(0, 4) }).catch(fail);
      resolve(true);
    };
    $("#sd-all").onclick = async () => {
      done = true; ctx.closeSheet();
      if (!(await ctx.confirmBox("Tout supprimer ?", `Le séjour et ses ${plural(n, "photo")} seront supprimés pour toute la famille. Cette action est définitive.`))) return resolve(false);
      store.deleteAlbumAll(sid, id).catch(fail);
      resolve(true);
    };
  });
}

/* ---------- Réglages : administrateur et place disponible ---------- */
export async function renderSettingsExtras() {
  const box = $("#settings-album"); if (!box || !ctx.state.spaceId) return;
  if (adminHash === undefined) { try { adminHash = await store.getAdminHash(ctx.state.spaceId); } catch { } }
  const admin = isAdmin();
  $("#admin-state").innerHTML = adminHash == null
    ? `<p class="small muted">Aucun code administrateur pour l'instant. Choisissez-en un (différent du code d'accès) : il permet de tout modifier ou supprimer dans l'Album.</p>
       <button class="btn btn-block" data-adm="define">Définir le code administrateur</button>`
    : admin
      ? `<p class="admin-on">✓ Mode administrateur activé sur ce téléphone</p>
         <div class="btn-row"><button class="btn" data-adm="change">Changer le code</button><button class="btn" data-adm="off">Quitter</button></div>`
      : `<p class="small muted">Permet de tout modifier ou supprimer dans l'Album.</p><button class="btn btn-block" data-adm="on">Activer avec le code</button>`;
  const g = $("#photo-usage");
  if (!navigator.onLine) { g.innerHTML = `<p class="small muted">Disponible avec une connexion Internet.</p>`; return; }
  g.innerHTML = `<p class="small muted">Calcul…</p>`;
  try {
    const u = await store.photoUsage(ctx.state.spaceId);
    const LIMIT = 1024 ** 3; // offre gratuite de Firestore : 1 Gio
    // Taille moyenne d'une photo (bornée pour rester réaliste tant qu'il y a peu de photos).
    const avg = Math.min(280000, Math.max(120000, u.count ? u.bytes / u.count : 230000));
    const cap = Math.round((LIMIT * 0.95) / avg / 100) * 100;
    const pct = Math.min(100, Math.round(u.bytes / LIMIT * 100));
    g.innerHTML = `
      <p class="usage-text">Photos : <strong>${fmtN(u.count)}</strong> / environ ${fmtN(cap)}</p>
      <div class="progress usage-bar ${pct >= 80 ? "warn" : ""}"><span style="width:${Math.max(pct, u.count ? 1 : 0)}%"></span></div>
      <p class="small muted">${pct}% de l'espace gratuit utilisé (Album et Restos & bars).</p>
      ${pct >= 80 ? `<p class="usage-warn">L'espace gratuit est presque plein : pensez à faire du tri dans les photos.</p>` : ""}`;
  } catch (e) { console.error(e); g.innerHTML = `<p class="small muted">Calcul impossible pour le moment.</p>`; }
}
function adminSheet(mode) {
  const define = mode === "define" || mode === "change";
  ctx.openSheet(`
    <h3>${mode === "on" ? "Mode administrateur" : "Code administrateur"}</h3>
    <form id="adm-form" autocomplete="off">
      ${define ? `<p class="small muted">Au moins 6 lettres ou chiffres, différent du code d'accès. Il n'est jamais enregistré en clair.</p>` : ""}
      <input id="adm-1" type="password" autocomplete="off" placeholder="${define ? "Nouveau code administrateur" : "Code administrateur"}">
      ${define ? `<input id="adm-2" type="password" autocomplete="off" placeholder="Retapez le code">` : ""}
      <p class="error" id="adm-error" hidden></p>
      <div class="btn-row"><button type="button" class="btn" id="adm-cancel">Annuler</button><button type="submit" class="btn btn-primary" id="adm-ok">${define ? "Enregistrer" : "Activer"}</button></div>
    </form>`);
  setTimeout(() => $("#adm-1")?.focus(), 100);
  $("#adm-cancel").onclick = () => ctx.closeSheet();
  $("#adm-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const err = (m) => { const e = $("#adm-error"); e.textContent = m; e.hidden = false; };
    const c1 = $("#adm-1").value;
    if (store.normalizeCode(c1).length < 6) return err("Au moins 6 lettres ou chiffres.");
    if (define && store.normalizeCode(c1) !== store.normalizeCode($("#adm-2").value)) return err("Les deux codes ne sont pas identiques.");
    if (!navigator.onLine && define) return err("Connexion nécessaire.");
    const btn = $("#adm-ok"); btn.disabled = true; btn.textContent = "Vérification…";
    const h = await store.deriveAdminHash(ctx.state.spaceId, c1);
    if (define) {
      try { await store.setAdminHash(ctx.state.spaceId, h); } catch (e) { btn.disabled = false; return err("Enregistrement impossible."); }
      adminHash = h;
    } else if (h !== adminHash) { btn.disabled = false; btn.textContent = "Activer"; return err("Code incorrect."); }
    try { localStorage.setItem(LS_ADMIN, h); } catch { }
    ctx.closeSheet(); ctx.toast("Mode administrateur activé"); renderSettingsExtras(); update();
  };
}

export function initAlbum(context) {
  ctx = context;
  const root = $("#album-root");
  root.addEventListener("click", onClick);
  const input = document.createElement("input");
  Object.assign(input, { type: "file", id: "al-files", accept: "image/*", multiple: true, hidden: true });
  document.body.appendChild(input);
  input.addEventListener("change", () => { if (input.files.length) uploadFiles([...input.files]); });
  $("#settings-album")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-adm]"); if (!b) return;
    if (b.dataset.adm === "off") { try { localStorage.removeItem(LS_ADMIN); } catch { } ctx.toast("Mode administrateur désactivé"); renderSettingsExtras(); update(); return; }
    adminSheet(b.dataset.adm);
  });
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  initViewer();
}
