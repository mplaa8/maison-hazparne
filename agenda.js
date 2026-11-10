// Onglet « Agenda » : événements culturels et locaux pendant un séjour.
// Données : data/events.json (liste de référence + images libres) et data/live/AAAA-MM.json
// (agenda culturel ouvert d'Euskadi, régénéré chaque nuit par une GitHub Action).

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const CARD_COLORS = ["#2b535c", "#b5654a", "#5e7d4e", "#6b5b8a", "#3f6f8f", "#9a6b2f", "#7a4b5c", "#4b6b6b"];
const PAGE = 20;

let ctx = null;              // fonctions fournies par app.js
let base = null;             // contenu de data/events.json
const liveCache = new Map(); // "AAAA-MM" -> événements
const ui = { choice: null, from: null, to: null, sort: "famous", shown: PAGE, liveOpen: false };

function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function dayMonth(s) { const d = parse(s); return `${d.getUTCDate()}${d.getUTCDate() === 1 ? "er" : ""} ${MONTHS[d.getUTCMonth()]}`; }
function longDay(s) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(parse(s));
}
function rangeLabel(a, b) {
  if (a === b) return "le " + longDay(a);
  const ya = a.slice(0, 4), yb = b.slice(0, 4);
  if (a.slice(0, 7) === b.slice(0, 7)) return `du ${parse(a).getUTCDate()}${parse(a).getUTCDate() === 1 ? "er" : ""} au ${dayMonth(b)} ${yb}`;
  return `du ${dayMonth(a)}${ya !== yb ? " " + ya : ""} au ${dayMonth(b)} ${yb}`;
}

function km(lat, lon) {
  const h = base?.home; if (!h || lat == null || lon == null) return null;
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat - h.lat) * rad, dLon = (lon - h.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(h.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function colorFor(city) {
  let h = 0; for (const c of city) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CARD_COLORS[h % CARD_COLORS.length];
}

async function loadBase() {
  if (base) return base;
  const r = await fetch("data/events.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("events.json");
  base = await r.json();
  return base;
}
async function loadLive(from, to) {
  const months = [];
  let d = parse(from.slice(0, 7) + "-01");
  while (iso(d).slice(0, 7) <= to.slice(0, 7)) { months.push(iso(d).slice(0, 7)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); }
  const avail = new Set(base.liveMonths || []);
  const out = [];
  await Promise.all(months.filter(m => avail.has(m)).map(async (m) => {
    if (!liveCache.has(m)) {
      try { const r = await fetch(`data/live/${m}.json`); liveCache.set(m, r.ok ? await r.json() : []); }
      catch { liveCache.set(m, []); }
    }
    out.push(...liveCache.get(m));
  }));
  return out;
}

/* ---------- Sélecteur de séjour ---------- */
function stayOptions() {
  const { state, memberById, me, todayStr, withText } = ctx;
  const today = todayStr();
  const meId = me()?.id;
  const upcoming = state.stays.filter(s => s.end >= today).sort((a, b) => a.start.localeCompare(b.start));
  const isMine = (s) => meId && (s.memberId === meId || (Array.isArray(s.guestIds) && s.guestIds.includes(meId)));
  const label = (s) => `${memberById(s.memberId)?.name || "Séjour"} · ${rangeLabel(s.start, s.end)}`;
  const mine = upcoming.filter(isMine), others = upcoming.filter(s => !isMine(s));
  return { mine, others, label, first: mine[0] || null };
}

function renderStaySelect() {
  const { mine, others, label, first } = stayOptions();
  const sel = $("#ag-stay");
  const all = [...mine, ...others];
  if (!ui.choice || (ui.choice !== "custom" && !all.some(s => s.id === ui.choice))) {
    ui.choice = first ? first.id : (all[0]?.id || "custom");
  }
  const opt = (s) => `<option value="${esc(s.id)}" ${s.id === ui.choice ? "selected" : ""}>${esc(label(s))}</option>`;
  sel.innerHTML =
    (mine.length ? `<optgroup label="Mes séjours">${mine.map(opt).join("")}</optgroup>` : "") +
    (others.length ? `<optgroup label="${mine.length ? "Autres séjours de la famille" : "Séjours de la famille"}">${others.map(opt).join("")}</optgroup>` : "") +
    `<option value="custom" ${ui.choice === "custom" ? "selected" : ""}>Autres dates…</option>`;
  $("#ag-dates").hidden = ui.choice !== "custom";
  if (ui.choice === "custom") {
    const t = ctx.todayStr();
    if (!ui.from) ui.from = t;
    if (!ui.to || ui.to < ui.from) ui.to = addDays(ui.from, 7);
    $("#ag-from").value = ui.from; $("#ag-to").value = ui.to;
  }
}

function currentRange() {
  if (ui.choice === "custom") {
    let a = $("#ag-from").value, b = $("#ag-to").value;
    if (!a) return null; if (!b || b < a) b = a;
    return { from: a, to: b, title: rangeLabel(a, b) };
  }
  const s = ctx.state.stays.find(x => x.id === ui.choice);
  return s ? { from: s.start, to: s.end, title: rangeLabel(s.start, s.end) } : null;
}

/* ---------- Liste ---------- */
let renderToken = 0;
export async function renderAgenda() {
  if (!ctx || $("#ag-events").hidden) return;
  renderStaySelect();
  const token = ++renderToken;
  const list = $("#ag-list"), summary = $("#ag-summary");
  const range = currentRange();
  if (!range) { list.innerHTML = ""; summary.textContent = "Choisissez des dates."; return; }
  summary.textContent = "Recherche des événements…";
  try { await loadBase(); } catch {
    if (token !== renderToken) return;
    summary.textContent = ""; list.innerHTML = `<div class="empty-state">Impossible de charger l'agenda. Vérifiez votre connexion Internet.</div>`;
    return;
  }
  const live = await loadLive(range.from, range.to);
  if (token !== renderToken) return;

  const seen = new Set();
  const inRange = (e) => {
    if (e.start > range.to || e.end < range.from) return false;
    const k = e.id + "|" + e.start; if (seen.has(k)) return false; seen.add(k); return true;
  };
  const dist = (e) => (e.km == null ? 9999 : e.km);
  const sorter = ui.sort === "near"
    ? (a, b) => dist(a) - dist(b) || b.note - a.note || a.start.localeCompare(b.start)
    : (a, b) => b.note - a.note || dist(a) - dist(b) || a.start.localeCompare(b.start);
  const withKm = (e) => ({ ...e, km: km(e.lat, e.lon) });
  // 1) Grands événements (liste de référence) ; 2) agenda culturel d'Euskadi, très fourni, replié par défaut.
  const main = base.events.filter(inRange).map(withKm).sort(sorter);
  const extra = live.filter(inRange).map(withKm).sort(sorter);

  if (!main.length && !extra.length) {
    const t = base.tourismOffice || { name: "Office de Tourisme Pays Basque", url: "https://www.en-pays-basque.fr" };
    summary.textContent = "";
    list.innerHTML = `
      <div class="ev-empty">
        <div class="ev-empty-emoji" aria-hidden="true">🌿</div>
        <p><strong>Pas de grande fête repérée ${esc(range.title)}.</strong></p>
        <p class="muted">C'est le moment idéal pour une balade sur l'Ursuya, un marché de village ou une partie de pelote ! Les petites animations locales sont recensées par l'office de tourisme.</p>
        <a class="btn btn-primary btn-block" href="${esc(t.url)}" target="_blank" rel="noopener">Voir l'agenda de l'${esc(t.name)} ↗</a>
      </div>`;
    return;
  }
  summary.textContent = main.length
    ? `${main.length} grand${main.length > 1 ? "s" : ""} événement${main.length > 1 ? "s" : ""} ${range.title}`
    : `Aucun grand événement ${range.title}, mais l'agenda culturel d'Euskadi propose des sorties.`;
  let html = main.map(card).join("");
  if (!main.length) {
    const t = base.tourismOffice;
    html += `<div class="ev-empty small"><p class="muted">Pour les animations de village côté Pays basque français : <a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} ↗</a></p></div>`;
  }
  if (extra.length) {
    const cities = [...new Set(extra.map(e => e.city.split(" – ")[0]))].slice(0, 4).join(", ");
    html += `
      <div class="ev-extra">
        <button class="ev-extra-toggle" id="ag-live-toggle" aria-expanded="${ui.liveOpen}">
          <span><strong>Aussi au programme : ${extra.length} concert${extra.length > 1 ? "s" : ""}, spectacles et festivals</strong>
          <span class="small muted">${esc(cities)} · agenda culturel d'Euskadi (Kulturklik), en espagnol</span></span>
          <span class="ev-chevron" aria-hidden="true">${ui.liveOpen ? "▴" : "▾"}</span>
        </button>
      </div>`;
    if (ui.liveOpen) {
      html += extra.slice(0, ui.shown).map(card).join("") +
        (extra.length > ui.shown ? `<button class="btn btn-block" id="ag-more">Afficher plus (${extra.length - ui.shown} autres)</button>` : "");
    }
  }
  html += `<p class="small muted ev-sources">Sources : liste de référence des grands événements (dates vérifiées sur les sites officiels) et agenda culturel ouvert du Gouvernement basque (Kulturklik). Distances à vol d'oiseau depuis Hasparren.</p>`;
  list.innerHTML = html;
  const more = $("#ag-more");
  if (more) more.onclick = () => { ui.shown += PAGE; renderAgenda(); };
  const tog = $("#ag-live-toggle");
  if (tog) tog.onclick = () => { ui.liveOpen = !ui.liveOpen; ui.shown = PAGE; renderAgenda(); };
}

function card(e) {
  const img = e.image;
  const media = img
    ? `<figure class="ev-media">
         <img src="${esc(img.src)}" alt="${esc(e.name)}" loading="lazy" width="800" height="450">
         <figcaption>Photo : ${esc(img.author || "auteur inconnu")} · <a href="${esc(img.page)}" target="_blank" rel="noopener">${esc(img.license)}</a>, via Wikimedia Commons</figcaption>
       </figure>`
    : `<div class="ev-placeholder" style="background:${colorFor(e.city)}"><span>${esc(e.city)}</span></div>`;
  const distance = e.km == null ? "" : (e.km < 2 ? " · à Hasparren" : ` · à ${Math.round(e.km)} km`);
  const tag = e.confirmed ? "" : `<span class="ev-tag">Dates à confirmer</span>`;
  const stars = e.source === "reference" ? `<span class="ev-stars" aria-label="Notoriété ${e.note} sur 5">${"★".repeat(e.note)}${"☆".repeat(5 - e.note)}</span>` : "";
  const extra = e.source === "kulturklik"
    ? `<p class="ev-source small muted">${esc(e.category || "")}${e.place ? " · " + esc(e.place) : ""} · agenda Kulturklik${e.lang === "es" ? " (description en espagnol)" : ""}</p>` : "";
  return `
    <article class="ev-card">
      ${media}
      <div class="ev-body">
        <div class="ev-meta">${esc(e.city)}${distance}${stars}</div>
        <h3 class="ev-title">${esc(e.name)}</h3>
        <div class="ev-dates">${esc(rangeLabel(e.start, e.end))} ${tag}</div>
        ${e.description ? `<p class="ev-desc">${esc(e.description)}</p>` : ""}
        ${extra}
        <div class="ev-links">
          <a class="btn btn-small" href="${esc(e.url)}" target="_blank" rel="noopener">Site officiel ↗</a>
          ${e.webcam ? `<a class="btn btn-small" href="${esc(e.webcam)}" target="_blank" rel="noopener">● Voir en direct</a>` : ""}
        </div>
      </div>
    </article>`;
}

export function initAgenda(context) {
  ctx = context;
  $("#ag-stay").addEventListener("change", (e) => { ui.choice = e.target.value; ui.shown = PAGE; ui.liveOpen = false; renderAgenda(); });
  for (const id of ["#ag-from", "#ag-to"]) {
    $(id).addEventListener("change", () => {
      ui.from = $("#ag-from").value; ui.to = $("#ag-to").value;
      if (ui.to && ui.from && ui.to < ui.from) { ui.to = ui.from; $("#ag-to").value = ui.to; }
      ui.shown = PAGE; renderAgenda();
    });
  }
  document.querySelectorAll("#ag-sort [data-sort]").forEach(b => b.addEventListener("click", () => {
    ui.sort = b.dataset.sort; ui.shown = PAGE;
    document.querySelectorAll("#ag-sort [data-sort]").forEach(x => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", x === b); });
    renderAgenda();
  }));
}

/** Pour les tests et le lien direct : choisir des dates. */
export function setAgendaDates(from, to) { ui.choice = "custom"; ui.from = from; ui.to = to; ui.shown = PAGE; }
