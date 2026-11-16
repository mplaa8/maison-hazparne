// Onglet « Agenda » › « Album » : les photos de famille, rangées en  Années › Événements › Photos.
// Aucun lien avec le planning : une année apparaît dès qu'un événement ou une photo la porte.
// Photos : même méthode gratuite que les Restos & bars (compression dans le navigateur, une photo par
// document Firestore, miniature à part). Tout est sous le chemin secret du planning, rien dans le dépôt.
//
// Droits : tout le monde crée des événements et ajoute des photos ; chacun modifie, déplace ou supprime
// ses propres photos ; seul l'auteur d'un événement le renomme ou le supprime ; le mode administrateur
// (Réglages) permet tout. Ces droits sont appliqués par l'app (il n'y a pas de comptes).
import * as store from "./store.js";
import { compress } from "./places.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MAX_PER_PERSON = 30;      // par personne et par événement
const LOOSE_HINT = 10;          // au-delà, on suggère de créer un événement
const LS_ADMIN = "mh.admin";

let ctx = null;
const data = { years: [], loaded: false, error: false };
const ui = { view: "years", year: null, eventId: null, upload: null, newEvent: null };
const content = { key: null, events: [], photos: [], eventPhotos: [], loaded: false };
let unsubYears = null, unsubContent = null, subSpace = null, rebuilt = false;
const thumbs = new Map(); // id → miniature (mosaïques)
const fulls = new Map();  // id → photo complète (visionneuse)
let adminHash = undefined;
const hinted = new Set();  // années pour lesquelles on a déjà suggéré de créer un événement

/* ---------- Utilitaires ---------- */
const tsMs = (t) => (t?.toMillis ? t.toMillis() : typeof t === "number" ? t : t?.seconds ? t.seconds * 1000 : Date.now());
function dayText(ms) { const d = new Date(ms); return `${d.getDate()}${d.getDate() === 1 ? "er" : ""} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
const photoTime = (p) => (p.takenAt ? Date.parse(p.takenAt) : tsMs(p.createdAt));
const byTime = (a, b) => photoTime(a) - photoTime(b);
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
const fmtN = (n) => n.toLocaleString("fr-FR");
const fail = (ex) => { console.error(ex); ctx.toast("Erreur d'enregistrement. Réessayez."); };
const nameOf = (id, fallback) => (id && ctx.memberById(id)?.name) || fallback || "Quelqu'un";
const thisYear = () => String(new Date().getFullYear());
export const isAdmin = () => { try { return !!adminHash && localStorage.getItem(LS_ADMIN) === adminHash; } catch { return false; } };
const mine = (x) => isAdmin() || (!!x.authorId && x.authorId === ctx.me()?.id);
/** « 25 décembre 2024 », « décembre 2024 » ou « 2024 ». */
function eventDate(e) {
  if (e.month && e.day) return `${e.day}${e.day === 1 ? "er" : ""} ${MONTHS[e.month - 1]} ${e.year}`;
  if (e.month) return `${MONTHS[e.month - 1]} ${e.year}`;
  return String(e.year);
}
const eventSort = (a, b) => (a.month || 13) - (b.month || 13) || (a.day || 32) - (b.day || 32) || tsMs(a.createdAt) - tsMs(b.createdAt);
const validYear = (y) => /^\d{4}$/.test(String(y)) && Number(y) >= 1850 && Number(y) <= new Date().getFullYear() + 1;

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
  if (!id || (unsubYears && subSpace === id)) return;
  stopAlbum();
  subSpace = id;
  unsubYears = store.subscribeAlbumYears(id, (list) => {
    data.years = list; data.loaded = true; data.error = false; update();
    // Synthèses absentes alors qu'il y a des photos (ex. photos de la première version) : on les recalcule.
    if (!list.length && !rebuilt && navigator.onLine) {
      rebuilt = true;
      store.albumCounts(id).then(c => { if (c.photos && !c.years) return store.rebuildAlbumYears(id); }).catch(e => console.error(e));
    }
  }, (e) => { console.error(e); data.error = true; update(); });
  store.getAdminHash(id).then(h => { adminHash = h; update(); }).catch(() => { });
}
export function stopAlbum() {
  if (unsubYears) { unsubYears(); unsubYears = null; }
  closeContent();
  Object.assign(data, { years: [], loaded: false, error: false });
  Object.assign(ui, { view: "years", year: null, eventId: null });
  thumbs.clear(); fulls.clear(); subSpace = null; adminHash = undefined; rebuilt = false;
}
function closeContent() {
  if (unsubContent) { unsubContent(); unsubContent = null; }
  Object.assign(content, { key: null, events: [], photos: [], eventPhotos: [], loaded: false, hadItems: false });
}
/** Écoute le contenu de l'année affichée (événements + autres photos) et, le cas échéant, de l'événement. */
function openContent(year, eventId) {
  const key = `${year}|${eventId || ""}`;
  if (content.key === key) return;
  closeContent();
  content.key = key;
  const sid = ctx.state.spaceId;
  const subs = [store.subscribeYear(sid, year, {
    onEvents: (e) => { content.events = e; update(); },
    onPhotos: (p) => { content.photos = p; if (!eventId) content.loaded = true; p.forEach(x => thumbs.set(x.id, x.thumb)); update(); if (viewer.open) renderViewer(); },
    onError: (e) => { console.error(e); content.loaded = true; update(); },
  })];
  if (eventId) subs.push(store.subscribeEventPhotos(sid, eventId, (p) => {
    content.eventPhotos = p; content.loaded = true; p.forEach(x => thumbs.set(x.id, x.thumb)); update(); if (viewer.open) renderViewer();
  }, (e) => { console.error(e); content.loaded = true; update(); }));
  unsubContent = () => subs.forEach(u => u());
}
const visible = () => ctx.state.tab === "agenda" && ctx.agendaMode() === "album";
function update() { if (visible()) renderAlbum(); }
const yearsList = () => data.years.filter(y => (y.count || 0) > 0 || (y.events || 0) > 0).sort((a, b) => b.id.localeCompare(a.id));

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
  if (ui.view === "event") {
    openContent(ui.year, ui.eventId);
    const ev = content.events.find(e => e.id === ui.eventId);
    if (ev) { ui.newEvent = null; root.innerHTML = eventHtml(ev); return; }
    if (!content.loaded || ui.newEvent === ui.eventId) { root.innerHTML = `<p class="small muted">Chargement…</p>`; return; }
    ui.view = "year"; ui.eventId = null;
  }
  if (ui.view === "year") {
    openContent(ui.year, null);
    const y = data.years.find(x => x.id === ui.year);
    if (content.events.length || content.photos.length) content.hadItems = true;
    // Année vidée (dernier événement ou dernière photo supprimés ou déplacés) : retour à la liste.
    if (content.hadItems && !ui.upload && content.loaded && !content.events.length && !content.photos.length && !(y && (y.count || y.events))) { ui.view = "years"; ui.year = null; }
    else { root.innerHTML = yearHtml(ui.year); return; }
  }
  closeContent();
  root.innerHTML = yearsHtml();
}

function mosaic(ids) {
  return `<span class="al-mosaic" aria-hidden="true">${[0, 1, 2, 3].map(i => {
    const id = ids[i], t = id && thumbs.get(id);
    if (id && !thumbs.has(id)) loadThumb(id);
    return t ? `<span class="al-tile"><img src="${esc(t)}" alt="" loading="lazy"></span>` : `<span class="al-tile al-tile-empty"></span>`;
  }).join("")}</span>`;
}
function loadThumb(id) {
  thumbs.set(id, null);
  store.getAlbumThumb(ctx.state.spaceId, id).then(t => { if (t) { thumbs.set(id, t); update(); } else thumbs.delete(id); }).catch(() => thumbs.delete(id));
}
const sampled = new Set();
function mosaicIds(y) {
  const ids = (y.previews || []).slice(0, 4);
  // Aperçus incomplets (photos supprimées) : on complète une fois avec quelques photos de l'année.
  if (ids.length < Math.min(4, y.count || 0) && !sampled.has(y.id)) {
    sampled.add(y.id);
    store.yearSample(ctx.state.spaceId, y.id).then(list => {
      list.forEach(p => thumbs.set(p.id, p.thumb));
      y.previews = [...new Set([...(y.previews || []), ...list.map(p => p.id)])]; update();
    }).catch(() => { });
  }
  return ids;
}
function topButtons(opts = {}) {
  const add = !navigator.onLine ? `<button class="btn btn-block pl-photo-btn" disabled>Connexion nécessaire pour envoyer des photos</button>`
    : `<button class="btn btn-primary btn-block al-add" data-act="pick" ${ui.upload ? "disabled" : ""}>📷 Ajouter des photos</button>`;
  return `<div class="al-actions">${add}${opts.noEvent ? "" : `<button class="btn btn-block" data-act="new-event">+ Créer un événement</button>`}</div>`;
}
function uploadBar() {
  const up = ui.upload;
  return up ? `<div class="pl-upload" role="status"><div class="progress"><span style="width:${Math.round(up.done / up.steps * 100)}%"></span></div><span class="progress-label">${esc(up.label)}</span></div>` : "";
}

function yearsHtml() {
  const list = yearsList();
  return `${topButtons()}${uploadBar()}
    ${!data.loaded ? `<p class="small muted">Chargement…</p>` : list.length ? `<div class="al-years">${list.map(y => `
      <button class="al-year" data-act="open-year" data-id="${esc(y.id)}">
        ${mosaic(mosaicIds(y))}
        <span class="al-year-text"><span class="al-year-title">${esc(y.id)}</span>
          <span class="al-year-sub">${plural(y.count || 0, "photo")}${y.events ? ` · ${plural(y.events, "événement")}` : ""}</span></span>
      </button>`).join("")}</div>`
      : `<div class="ev-empty"><div class="ev-empty-emoji" aria-hidden="true">📷</div><p><strong>Aucune photo pour l'instant.</strong></p><p class="muted">Créez un premier événement ou ajoutez vos photos.</p></div>`}`;
}

function grid(photos) {
  return `<div class="pl-gallery al-grid">${photos.map(p => `
    <button class="pl-thumb" data-act="view" data-id="${esc(p.id)}" aria-label="Photo de ${esc(nameOf(p.authorId, p.authorName))}${p.caption ? " : " + esc(p.caption) : ""}">
      <img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async">
    </button>`).join("")}</div>`;
}

function yearHtml(y) {
  const evs = [...content.events].sort(eventSort);
  const loose = [...content.photos].sort(byTime);
  return `
    <button class="link-btn pl-back" data-act="back-years">‹ Toutes les années</button>
    <h2 class="pl-title">${esc(y)}</h2>
    ${topButtons()}${uploadBar()}
    ${evs.length ? `<h3 class="memo-title al-section">Événements</h3><div class="al-events">${evs.map(e => `
      <button class="al-event" data-act="open-event" data-id="${esc(e.id)}">
        <span class="al-cover">${e.cover ? `<img src="${esc(e.cover)}" alt="" loading="lazy">` : `<span class="al-event-empty" aria-hidden="true">✦</span>`}</span>
        <span class="al-album-title">${esc(e.title)}</span>
        <span class="al-album-sub">${esc(eventDate(e))} · ${plural(e.count || 0, "photo")}</span>
      </button>`).join("")}</div>` : ""}
    ${loose.length || !evs.length ? `<h3 class="memo-title al-section">${evs.length ? `Autres photos de ${esc(y)}` : "Photos"}${loose.length ? ` <span class="muted pl-count">${loose.length}</span>` : ""}</h3>
      ${!content.loaded ? `<p class="small muted">Chargement…</p>` : loose.length ? grid(loose) : `<p class="small muted memo-empty">Pas encore de photo.</p>`}` : ""}`;
}

function eventHtml(e) {
  const photos = [...content.eventPhotos].sort(byTime);
  return `
    <button class="link-btn pl-back" data-act="back-year">‹ ${esc(e.year)}</button>
    <h2 class="pl-title">${esc(e.title)}</h2>
    <p class="pl-detail-sub">${esc(cap(eventDate(e)))} · ${plural(photos.length, "photo")} · créé par ${esc(nameOf(e.authorId, e.authorName))}</p>
    ${topButtons({ noEvent: true })}${uploadBar()}
    ${!content.loaded ? `<p class="small muted">Chargement…</p>` : photos.length ? grid(photos) : `<p class="small muted memo-empty">Pas encore de photo dans cet événement.</p>`}
    ${mine(e) ? `<div class="check-footer pl-actions"><button class="link-btn" data-act="edit-event">Modifier l'événement</button><button class="link-btn danger" data-act="delete-event">Supprimer l'événement</button></div>` : ""}`;
}

/* ---------- Formulaires ---------- */
function dateFields(prefix, { year, month, day } = {}) {
  return `
    <div class="al-date-row">
      <div><label class="label" for="${prefix}-year">Année</label>
        <input id="${prefix}-year" inputmode="numeric" maxlength="4" value="${esc(year || "")}" placeholder="AAAA"></div>
      <div><label class="label" for="${prefix}-month">Mois <span class="muted">(facultatif)</span></label>
        <select id="${prefix}-month"><option value="">—</option>${MONTHS.map((m, i) => `<option value="${i + 1}" ${month === i + 1 ? "selected" : ""}>${cap(m)}</option>`).join("")}</select></div>
      <div><label class="label" for="${prefix}-day">Jour</label>
        <select id="${prefix}-day"><option value="">—</option>${Array.from({ length: 31 }, (_, i) => `<option ${day === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select></div>
    </div>`;
}
function readDate(prefix) {
  const year = $(`#${prefix}-year`).value.trim(), month = Number($(`#${prefix}-month`).value) || null;
  const day = month ? Number($(`#${prefix}-day`).value) || null : null;
  if (!validYear(year)) return { error: "Indiquez l'année (4 chiffres)." };
  if (day && day > new Date(Date.UTC(Number(year), month, 0)).getUTCDate()) return { error: "Ce jour n'existe pas dans ce mois." };
  return { year, month, day };
}
function eventSheet(e, presetYear) {
  ctx.openSheet(`
    <h3>${e ? "Modifier l'événement" : "Nouvel événement"}</h3>
    <form id="al-form" autocomplete="off">
      <label class="label" for="al-title">Titre</label>
      <input id="al-title" maxlength="80" value="${esc(e?.title || "")}" placeholder="Ex. Premier Noël, Anniversaire de Léa">
      ${dateFields("ev", e || { year: presetYear || "" })}
      <p class="error" id="al-error" hidden></p>
      <div class="btn-row"><button type="button" class="btn" id="al-cancel">Annuler</button><button type="submit" class="btn btn-primary">${e ? "Enregistrer" : "Créer"}</button></div>
    </form>`);
  if (!e) setTimeout(() => $("#al-title")?.focus(), 100);
  $("#al-cancel").onclick = () => { pendingMeta = null; ctx.closeSheet(); };
  $("#al-form").onsubmit = (ev) => {
    ev.preventDefault();
    const err = (m) => { const x = $("#al-error"); x.textContent = m; x.hidden = false; };
    const title = $("#al-title").value.trim().slice(0, 80);
    if (!title) return err("Donnez un titre à l'événement.");
    const d = readDate("ev"); if (d.error) return err(d.error);
    const sid = ctx.state.spaceId, meM = ctx.me();
    ctx.closeSheet();
    if (e) {
      store.updateAlbumEvent(sid, e, { title, year: d.year, month: d.month, day: d.day }, content.eventPhotos).catch(fail);
      if (d.year !== e.year) { ui.year = d.year; content.key = null; }
      return;
    }
    const { id, done } = store.addAlbumEvent(sid, { title, ...d, authorId: meM?.id || null, authorName: meM?.name || null });
    done.catch(fail);
    Object.assign(ui, { view: "event", year: d.year, eventId: id, newEvent: id }); renderAlbum(); window.scrollTo(0, 0);
    ctx.toast("Événement créé");
    // Créé depuis la fenêtre d'ajout : les photos choisies y sont rangées.
    if (pendingMeta) { const m = pendingMeta; pendingMeta = null; uploadFiles(m, { eventId: id, year: d.year, coverId: null }); }
  };
}
function textSheet(title, label, value, ok, max, onOk) {
  ctx.openSheet(`
    <h3>${esc(title)}</h3>
    <form id="al-form" autocomplete="off">
      <label class="label" for="al-input">${esc(label)}</label>
      <input id="al-input" maxlength="${max}" value="${esc(value || "")}">
      <div class="btn-row"><button type="button" class="btn" id="al-cancel">Annuler</button><button type="submit" class="btn btn-primary">${esc(ok)}</button></div>
    </form>`);
  setTimeout(() => $("#al-input")?.focus(), 100);
  $("#al-cancel").onclick = () => ctx.closeSheet();
  $("#al-form").onsubmit = (ev) => { ev.preventDefault(); onOk($("#al-input").value.trim().slice(0, max)); };
}
function needProfile() {
  ctx.openSheet(`
    <h3>Qui êtes-vous ?</h3>
    <p>Pour ajouter des photos, choisissez d'abord votre profil : elles seront enregistrées à votre nom.</p>
    <div class="btn-row"><button class="btn" id="al-no">Annuler</button><button class="btn btn-primary" id="al-who">Choisir mon profil</button></div>`);
  $("#al-no").onclick = () => ctx.closeSheet();
  $("#al-who").onclick = () => { ctx.closeSheet(); ctx.showWhoami(); };
}

/** Liste des événements pour les choix « Ranger dans » (toutes années). */
async function allEvents() {
  try { return (await store.listAlbumEvents(ctx.state.spaceId)).sort((a, b) => b.year.localeCompare(a.year) || eventSort(a, b)); }
  catch { return content.events; }
}
function eventOptions(evs, selected) {
  const byYear = new Map();
  evs.forEach(e => { if (!byYear.has(e.year)) byYear.set(e.year, []); byYear.get(e.year).push(e); });
  return [...byYear].map(([y, list]) => `<optgroup label="${esc(y)}">${list.map(e => `<option value="${esc(e.id)}" ${e.id === selected ? "selected" : ""}>${esc(e.title)} · ${esc(eventDate(e))}</option>`).join("")}</optgroup>`).join("");
}

/* ---------- Envoi des photos ---------- */
function pick() {
  if (!ctx.me()) return needProfile();
  if (!navigator.onLine) return ctx.toast("Connexion nécessaire pour envoyer des photos");
  const f = $("#al-files"); f.value = ""; f.click();
}
/** Fenêtre d'ajout : où ranger les photos (événement recommandé, ou seulement une année). */
async function addSheet(files) {
  files = [...files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name));
  if (!files.length) return;
  const meta = await Promise.all(files.map(async f => ({ f, takenAt: await exifDate(f), size: f.size })));
  // Année proposée : celle de la prise de vue la plus fréquente, sinon l'année affichée, sinon l'année en cours.
  const counts = {}; meta.forEach(m => { if (m.takenAt) counts[m.takenAt.slice(0, 4)] = (counts[m.takenAt.slice(0, 4)] || 0) + 1; });
  const exifYear = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const evs = await allEvents();
  const ctxEvent = ui.view === "event" ? evs.find(e => e.id === ui.eventId) : null;
  const year = ctxEvent?.year || exifYear || ui.year || thisYear();
  const yearWhy = ctxEvent ? `Année de l'événement « ${ctxEvent.title} ».` : exifYear ? `Année proposée d'après la date de prise de vue (${exifYear}).`
    : ui.year ? `Pas de date de prise de vue : année ${ui.year} proposée.` : "Pas de date de prise de vue : année en cours proposée.";
  const sameYear = evs.filter(e => e.year === year);
  // Un événement est recommandé : on présélectionne celui de la page ouverte, sinon un événement de l'année proposée.
  const selEvent = ctxEvent?.id || sameYear[0]?.id || null;
  const mode = selEvent ? "event" : "year";
  const urls = files.slice(0, 8).map(f => URL.createObjectURL(f));
  ctx.openSheet(`
    <h3>Ajouter ${plural(files.length, "photo")}</h3>
    <div class="al-strip">${urls.map(u => `<img src="${u}" alt="">`).join("")}${files.length > 8 ? `<span class="al-more">+${files.length - 8}</span>` : ""}</div>
    <p class="label">Ranger dans</p>
    <label class="al-choice ${evs.length ? "" : "disabled"}">
      <input type="radio" name="al-where" value="event" ${mode === "event" ? "checked" : ""} ${evs.length ? "" : "disabled"}>
      <span><strong>Un événement</strong> <span class="al-reco">recommandé</span>
        ${evs.length ? `<select id="al-event">${eventOptions(evs, selEvent || evs[0].id)}</select>` : `<span class="small muted">Aucun événement pour l'instant.</span>`}
        <button type="button" class="link-btn" id="al-new-event">+ Créer un événement</button></span>
    </label>
    <label class="al-choice">
      <input type="radio" name="al-where" value="year" ${mode === "year" ? "checked" : ""}>
      <span><strong>Seulement une année</strong> <span class="small muted">« Autres photos »</span>
        <input id="al-year" inputmode="numeric" maxlength="4" value="${esc(year)}" aria-label="Année"></span>
    </label>
    <p class="small muted al-exif">${esc(yearWhy)}</p>
    <p class="error" id="al-error" hidden></p>
    <div class="btn-row"><button type="button" class="btn" id="al-cancel">Annuler</button><button type="button" class="btn btn-primary" id="al-go">Ajouter</button></div>`,
    () => urls.forEach(u => URL.revokeObjectURL(u)));
  const where = () => document.querySelector('input[name="al-where"]:checked')?.value;
  $("#al-event")?.addEventListener("change", () => { document.querySelector('input[name="al-where"][value="event"]').checked = true; });
  $("#al-year").addEventListener("focus", () => { document.querySelector('input[name="al-where"][value="year"]').checked = true; });
  $("#al-cancel").onclick = () => ctx.closeSheet();
  $("#al-new-event").onclick = () => { ctx.closeSheet(); pendingMeta = meta; eventSheet(null, year); };
  $("#al-go").onclick = () => {
    const err = (m) => { const x = $("#al-error"); x.textContent = m; x.hidden = false; };
    let target;
    if (where() === "event") {
      const ev = evs.find(e => e.id === $("#al-event").value);
      if (!ev) return err("Choisissez un événement.");
      target = { eventId: ev.id, year: ev.year, title: ev.title, coverId: ev.coverId };
    } else {
      const y = $("#al-year").value.trim();
      if (!validYear(y)) return err("Indiquez l'année (4 chiffres).");
      target = { eventId: null, year: y };
    }
    ctx.closeSheet();
    uploadFiles(meta, target);
  };
}
let pendingMeta = null; // photos choisies avant de créer un événement depuis la fenêtre d'ajout

async function uploadFiles(meta, target) {
  if (ui.upload) return;
  const meM = ctx.me(), sid = ctx.state.spaceId;
  const notes = [];
  // Doublons : même taille de fichier et même date de prise de vue (dans tout l'album).
  const fresh = [], seen = new Set();
  for (const m of meta) {
    const k = `${m.size}|${m.takenAt || ""}`;
    if (seen.has(k)) continue;
    let dup = false;
    try { dup = (await store.photosWithSize(sid, m.size)).some(p => (p.takenAt || "") === (m.takenAt || "")); } catch { }
    seen.add(k);
    if (!dup) fresh.push(m);
  }
  const dupN = meta.length - fresh.length;
  if (dupN) notes.push(`${plural(dupN, "doublon")} ignoré${dupN > 1 ? "s" : ""}`);
  let list = fresh;
  // Limite : 30 photos par personne et par événement.
  if (target.eventId) {
    let already = 0;
    try { already = (await new Promise((res, rej) => { const u = store.subscribeEventPhotos(sid, target.eventId, (p) => { u(); res(p); }, rej); })).filter(p => p.authorId === meM.id).length; } catch { }
    const left = Math.max(0, MAX_PER_PERSON - already);
    if (list.length > left) {
      list = list.slice(0, left);
      ctx.openSheet(`<h3>Gardez vos ${MAX_PER_PERSON} plus belles !</h3>
        <p>Chacun peut mettre jusqu'à ${MAX_PER_PERSON} photos par événement, pour que l'album reste agréable à parcourir (et que la place gratuite dure longtemps).</p>
        <p class="muted">${left ? `Les ${plural(left, "première")} de votre sélection vont être ajoutées.` : "Vous avez déjà mis vos 30 photos dans cet événement : supprimez-en une pour en ajouter une autre."}</p>
        <button class="btn btn-primary btn-block" id="al-ok">D'accord</button>`);
      $("#al-ok").onclick = () => ctx.closeSheet();
    }
  }
  if (!list.length) { if (dupN) ctx.toast(notes.join(" · ")); return; }
  // On affiche l'endroit où les photos arrivent.
  Object.assign(ui, target.eventId ? { view: "event", year: target.year, eventId: target.eventId } : { view: "year", year: target.year, eventId: null });
  const steps = list.length * 2;
  ui.upload = { done: 0, steps, label: `Préparation de la photo 1 sur ${list.length}…` };
  const paint = () => {
    const bar = document.querySelector("#album-root .pl-upload .progress span"), lab = document.querySelector("#album-root .pl-upload .progress-label");
    if (bar) bar.style.width = Math.round(ui.upload.done / steps * 100) + "%";
    if (lab) lab.textContent = ui.upload.label;
  };
  renderAlbum(); window.scrollTo(0, 0);
  let previews = (data.years.find(y => y.id === target.year)?.previews || []).length, evCover = !!target.coverId, ok = 0, ko = 0;
  for (let i = 0; i < list.length; i++) {
    try {
      ui.upload.label = `Préparation de la photo ${i + 1} sur ${list.length}…`; paint();
      const { full, thumb } = await compress(list[i].f);
      ui.upload.done++; ui.upload.label = `Envoi de la photo ${i + 1} sur ${list.length}…`; paint();
      const { done } = store.addAlbumPhoto(sid, { year: target.year, eventId: target.eventId, thumb, full, authorId: meM.id, authorName: meM.name,
        takenAt: list[i].takenAt, srcSize: list[i].size }, { preview: previews < 4, eventCover: !!target.eventId && !evCover });
      await done;
      previews++; evCover = true; ok++;
    } catch (e) { console.error(e); ko++; }
    ui.upload.done = (i + 1) * 2; paint();
  }
  ui.upload = null;
  renderAlbum();
  notes.unshift(`${plural(ok, "photo")} ajoutée${ok > 1 ? "s" : ""}`);
  if (ko) notes.push(`${ko} impossible${ko > 1 ? "s" : ""} à lire`);
  ctx.toast(notes.join(" · "));
  // Garde-fou : beaucoup de photos en vrac dans une année → suggérer un événement.
  if (!target.eventId && !hinted.has(target.year)) {
    setTimeout(() => {
      const loose = content.key === `${target.year}|` ? content.photos.length : 0;
      if (loose > LOOSE_HINT && !hinted.has(target.year)) {
        hinted.add(target.year);
        ctx.openSheet(`<h3>Voulez-vous créer un événement pour les ranger ?</h3>
          <p>Il y a ${loose} photos dans « Autres photos de ${esc(target.year)} ». Un événement (« Premier Noël », « Vacances à Biarritz »…) les rend plus faciles à retrouver.</p>
          <div class="btn-row"><button class="btn" id="al-later">Plus tard</button><button class="btn btn-primary" id="al-create">Créer un événement</button></div>`);
        $("#al-later").onclick = () => ctx.closeSheet();
        $("#al-create").onclick = () => { ctx.closeSheet(); eventSheet(null, target.year); };
      }
    }, 900);
  }
}

/* ---------- Visionneuse ---------- */
const viewer = { open: false, ids: [], index: 0 };
const scopePhotos = () => [...(ui.view === "event" ? content.eventPhotos : content.photos)].sort(byTime);
function openViewer(photoId) {
  viewer.ids = scopePhotos().map(p => p.id); viewer.index = Math.max(0, viewer.ids.indexOf(photoId)); viewer.open = true;
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
  const cur = viewer.ids[viewer.index];
  viewer.ids = scopePhotos().map(p => p.id);
  if (!viewer.ids.length) return closeViewer();
  viewer.index = viewer.ids.includes(cur) ? viewer.ids.indexOf(cur) : Math.min(viewer.index, viewer.ids.length - 1);
  const p = scopePhotos().find(x => x.id === viewer.ids[viewer.index]);
  const ev = ui.view === "event" ? content.events.find(e => e.id === ui.eventId) : null;
  const full = fulls.get(p.id);
  if (!full) loadFull(p.id);
  [-1, 1].forEach(k => { const o = viewer.ids[(viewer.index + k + viewer.ids.length) % viewer.ids.length]; if (o) loadFull(o); });
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
        ${ev ? (ev.coverId === p.id ? `<span class="pv-chip">✓ Couverture</span>` : `<button class="pv-chip" data-pv="cover">Mettre en couverture</button>`) : ""}
        ${mine(p) ? `<button class="pv-chip" data-pv="caption">${p.caption ? "Modifier la légende" : "Légende"}</button>
          <button class="pv-chip" data-pv="move">Déplacer</button>
          <button class="pv-chip pv-danger" data-pv="delete">Supprimer</button>` : ""}
      </div>
    </div>`;
}
function nextCover(list, removedId) { const o = list.filter(x => x.id !== removedId).sort(byTime)[0]; return o ? { id: o.id, thumb: o.thumb } : null; }
async function viewerAction(act) {
  const p = scopePhotos().find(x => x.id === viewer.ids[viewer.index]); if (!p) return;
  const sid = ctx.state.spaceId;
  if (act === "cover") {
    store.setEventCover(sid, ui.eventId, p).then(() => { ctx.toast("Couverture de l'événement"); renderViewer(); }).catch(fail);
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
    const evs = await allEvents();
    ctx.openSheet(`
      <h3>Déplacer la photo</h3>
      <label class="al-choice"><input type="radio" name="mv" value="event" ${p.eventId ? "checked" : ""} ${evs.length ? "" : "disabled"}>
        <span><strong>Vers un événement</strong>${evs.length ? `<select id="mv-event">${eventOptions(evs, p.eventId || evs[0].id)}</select>` : `<span class="small muted">Aucun événement.</span>`}</span></label>
      <label class="al-choice"><input type="radio" name="mv" value="year" ${p.eventId ? "" : "checked"}>
        <span><strong>Vers « Autres photos » d'une année</strong><input id="mv-year" inputmode="numeric" maxlength="4" value="${esc(p.year)}" aria-label="Année"></span></label>
      <p class="error" id="mv-error" hidden></p>
      <div class="btn-row"><button class="btn" id="mv-cancel">Annuler</button><button class="btn btn-primary" id="mv-ok">Déplacer</button></div>`);
    $("#mv-event")?.addEventListener("change", () => { document.querySelector('input[name="mv"][value="event"]').checked = true; });
    $("#mv-year").addEventListener("focus", () => { document.querySelector('input[name="mv"][value="year"]').checked = true; });
    $("#mv-cancel").onclick = () => ctx.closeSheet();
    $("#mv-ok").onclick = () => {
      const toEvent = document.querySelector('input[name="mv"]:checked').value === "event";
      const dest = toEvent ? evs.find(e => e.id === $("#mv-event").value) : null;
      const to = toEvent ? { eventId: dest.id, year: dest.year } : { eventId: null, year: $("#mv-year").value.trim() };
      if (!validYear(to.year)) { const x = $("#mv-error"); x.textContent = "Indiquez l'année (4 chiffres)."; x.hidden = false; return; }
      ctx.closeSheet();
      if (to.eventId === (p.eventId || null) && to.year === p.year) return;
      const from = p.eventId && content.events.find(e => e.id === p.eventId);
      const toYear = data.years.find(y => y.id === to.year);
      store.moveAlbumPhoto(sid, p, to, {
        fromEventCover: from && from.coverId === p.id ? nextCover(content.eventPhotos, p.id) : undefined,
        toEventCover: !!dest && !dest.coverId,
        preview: (toYear?.previews || []).length < 4,
      }).then(() => ctx.toast(dest ? `Photo rangée dans « ${dest.title} »` : `Photo rangée dans « Autres photos de ${to.year} »`)).catch(fail);
    };
    return;
  }
  if (act === "delete") {
    closeViewer();
    if (!(await ctx.confirmBox("Supprimer cette photo ?", `Photo ajoutée par ${nameOf(p.authorId, p.authorName)}. Elle sera supprimée pour toute la famille.`))) return openViewer(p.id);
    const ev = p.eventId && content.events.find(e => e.id === p.eventId);
    store.deleteAlbumPhoto(sid, p, { eventCover: ev && ev.coverId === p.id ? nextCover(content.eventPhotos, p.id) : undefined })
      .then(() => ctx.toast("Photo supprimée")).catch(fail);
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
    case "open-year": Object.assign(ui, { view: "year", year: id, eventId: null }); renderAlbum(); return top();
    case "open-event": Object.assign(ui, { view: "event", eventId: id }); renderAlbum(); return top();
    case "back-years": Object.assign(ui, { view: "years", year: null, eventId: null }); renderAlbum(); return top();
    case "back-year": Object.assign(ui, { view: "year", eventId: null }); renderAlbum(); return top();
    case "pick": return pick();
    case "view": return openViewer(id);
    case "new-event": return eventSheet(null, ui.view === "year" ? ui.year : "");
    case "edit-event": { const ev = content.events.find(x => x.id === ui.eventId); return ev && mine(ev) && eventSheet(ev); }
    case "delete-event": {
      const ev = content.events.find(x => x.id === ui.eventId); if (!ev || !mine(ev)) return;
      const ph = content.eventPhotos;
      if (!(await ctx.confirmBox("Supprimer l'événement ?", `« ${ev.title} » sera supprimé.${ph.length === 1 ? ` Sa photo reste dans « Autres photos de ${ev.year} ».` : ph.length ? ` Ses ${ph.length} photos restent dans « Autres photos de ${ev.year} ».` : ""}`))) return;
      Object.assign(ui, { view: "year", eventId: null }); renderAlbum();
      return store.deleteAlbumEvent(sid, ev, ph.map(p => p.id)).then(() => ctx.toast("Événement supprimé")).catch(fail);
    }
  }
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
  $("#album-root").addEventListener("click", onClick);
  const input = document.createElement("input");
  Object.assign(input, { type: "file", id: "al-files", accept: "image/*", multiple: true, hidden: true });
  document.body.appendChild(input);
  input.addEventListener("change", () => { if (input.files.length) addSheet([...input.files]); });
  $("#settings-album")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-adm]"); if (!b) return;
    if (b.dataset.adm === "off") { try { localStorage.removeItem(LS_ADMIN); } catch { } ctx.toast("Mode administrateur désactivé"); renderSettingsExtras(); update(); return; }
    adminSheet(b.dataset.adm);
  });
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  initViewer();
}
