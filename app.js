import * as store from "./store.js";

/* ---------- Constantes & utilitaires ---------- */
// Couleurs douces des membres (affichage). Les anciennes couleurs vives déjà
// enregistrées sont converties à l'affichage vers leur équivalent doux.
const COLORS = [
  "#e07a6c", "#5fae84", "#5b9bd5", "#eba15c", "#a98bd0", "#dcbb52", "#45a8a0",
  "#e58bb4", "#b08b70", "#7d8ea3", "#9cc56a", "#5ec2d6", "#f2a7a0", "#8a8fd8"
];
const LEGACY = {
  "#c8102e": 0, "#00843d": 1, "#1f6fb2": 2, "#e67e22": 3, "#8e44ad": 4, "#d4a017": 5, "#16a085": 6,
  "#e84393": 7, "#6d4c41": 8, "#34495e": 9, "#7cb342": 10, "#00acc1": 11, "#f4511e": 12, "#5c6bc0": 13
};
const col = (c) => (c && LEGACY[c.toLowerCase()] != null ? COLORS[LEGACY[c.toLowerCase()]] : c) || "#9aa0a6";
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const WEEKDAYS_SHORT = ["L", "M", "M", "J", "V", "S", "D"];
const LS_SPACE = "mh.space";
const LS_ME = "mh.me";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } }

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m : 0-11
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmt(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
function addDays(s, n) { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
function todayStr() { const n = new Date(); return ymd(n.getFullYear(), n.getMonth(), n.getDate()); }
const dfLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const dfShort = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
const dfDayMonth = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
const longDate = (s) => cap(dfLong.format(parse(s)));
const shortDate = (s) => dfShort.format(parse(s));

function rangeText(start, end) {
  if (start === end) return `le ${shortDate(start)}`;
  const n = daysBetween(start, end) + 1;
  const sy = start.slice(0, 4), ey = end.slice(0, 4);
  const a = dfDayMonth.format(parse(start)) + (sy !== ey ? " " + sy : "");
  const b = dfDayMonth.format(parse(end)) + (sy !== ey ? " " + ey : "");
  return `du ${a} au ${b} · ${n} jours`;
}

/* ---------- Invités ---------- */
const guestIdsOf = (s) => (Array.isArray(s.guestIds) ? s.guestIds : []).filter(id => id !== s.memberId && memberById(id));
const guestsOf = (s) => (Array.isArray(s.guests) ? s.guests : []).filter(n => typeof n === "string" && n.trim());
function frList(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " et " + items[items.length - 1];
}
/** « avec Léa, Paul et 1 invité (Jean) » — vide si la personne voyage seule. */
function withText(s) {
  const items = guestIdsOf(s).map(id => memberById(id).name);
  const ext = guestsOf(s);
  if (ext.length) items.push(`${ext.length} invité${ext.length > 1 ? "s" : ""} (${ext.join(", ")})`);
  return items.length ? "avec " + frList(items) : "";
}
const hostName = (s) => memberById(s.memberId)?.name || "Personne retirée";
const stayTitle = (s) => { const w = withText(s); return hostName(s) + (w ? " " + w : ""); };

/* ---------- État ---------- */
const state = {
  spaceId: null,
  members: [],
  stays: [],
  year: new Date().getFullYear(),
  tab: "calendar",
  selStart: null,
  unsub: null,
  membersLoaded: false,
  firstRender: true,
  newMemberColor: null,
};
const memberById = (id) => state.members.find(m => m.id === id);
const me = () => memberById(lsGet(LS_ME));

/* ---------- Écrans ---------- */
function show(screen) {
  for (const s of ["loading", "login", "whoami", "app"]) $("#screen-" + s).hidden = s !== screen;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

/* ---------- Fenêtre du bas ---------- */
let sheetOnClose = null;
function openSheet(html, onClose) {
  $("#sheet-body").innerHTML = html;
  $("#sheet-overlay").hidden = false;
  sheetOnClose = onClose || null;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet-overlay").hidden = true;
  $("#sheet-body").innerHTML = "";
  document.body.style.overflow = "";
  const cb = sheetOnClose; sheetOnClose = null; cb && cb();
}
$("#sheet-overlay").addEventListener("click", (e) => { if (e.target.id === "sheet-overlay") closeSheet(); });

function confirmBox(title, text, okLabel = "Supprimer", danger = true) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet(`
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <div class="btn-row">
        <button class="btn" id="cf-no">Annuler</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="cf-yes">${esc(okLabel)}</button>
      </div>`, () => { if (!answered) resolve(false); });
    $("#cf-no").onclick = () => { answered = true; resolve(false); closeSheet(); };
    $("#cf-yes").onclick = () => { answered = true; resolve(true); closeSheet(); };
  });
}

/* ---------- Connexion ---------- */
async function start() {
  if (!store.configured) {
    show("login");
    $("#login-error").textContent = "L'application n'est pas encore reliée à Firebase (configuration manquante).";
    $("#login-error").hidden = false;
    $("#login-btn").disabled = true;
    return;
  }
  const saved = lsGet(LS_SPACE);
  if (saved) {
    enterSpace(saved);
  } else {
    show("login");
    if (location.hash === "#creer") $("#create-space").hidden = false;
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#login-code").value;
  const err = $("#login-error");
  err.hidden = true;
  if (store.normalizeCode(code).length < 4) { err.textContent = "Code trop court."; err.hidden = false; return; }
  const btn = $("#login-btn");
  btn.disabled = true; btn.textContent = "Vérification…";
  try {
    const id = await store.deriveSpaceId(code);
    if (await store.spaceExists(id)) {
      lsSet(LS_SPACE, id);
      $("#login-code").value = "";
      enterSpace(id);
    } else {
      err.textContent = "Code incorrect. Vérifiez auprès de la famille.";
      err.hidden = false;
    }
  } catch (ex) {
    console.error(ex);
    err.textContent = "Impossible de vérifier le code. Vérifiez votre connexion Internet.";
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Entrer";
  }
});

$("#create-space-btn").addEventListener("click", async () => {
  const code = $("#login-code").value;
  const err = $("#login-error");
  if (store.normalizeCode(code).length < 8) { err.textContent = "Choisissez un code d'au moins 8 lettres ou chiffres."; err.hidden = false; return; }
  try {
    const id = await store.deriveSpaceId(code);
    if (await store.spaceExists(id)) { err.textContent = "Un espace existe déjà avec ce code : touchez « Entrer »."; err.hidden = false; return; }
    await store.createSpace(id);
    lsSet(LS_SPACE, id);
    history.replaceState(null, "", location.pathname);
    $("#create-space").hidden = true;
    enterSpace(id);
    toast("Espace créé !");
  } catch (ex) {
    console.error(ex);
    err.textContent = "Création impossible (règles Firestore ?)."; err.hidden = false;
  }
});

function enterSpace(id) {
  if (state.unsub) state.unsub();
  state.spaceId = id;
  state.membersLoaded = false;
  state.firstRender = true;
  show("loading");
  state.unsub = store.subscribe(id, {
    onMembers: (list) => {
      state.members = list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, "fr"));
      const first = !state.membersLoaded;
      state.membersLoaded = true;
      if (first) {
        if (!me()) showWhoami(); else showApp();
      }
      renderAll();
    },
    onStays: (list) => { state.stays = list; renderAll(); },
    onSpaceGone: () => kickOut("Le code d'accès a été changé. Demandez le nouveau code à la famille."),
    onError: async (e) => {
      console.error(e);
      try { if (!(await store.spaceExists(id))) kickOut("Le code d'accès a été changé. Demandez le nouveau code à la famille."); } catch { }
    }
  });
}

function kickOut(msg) {
  if (state.unsub) { state.unsub(); state.unsub = null; }
  lsSet(LS_SPACE, null);
  state.spaceId = null; state.members = []; state.stays = [];
  closeSheet();
  show("login");
  if (msg) { $("#login-error").textContent = msg; $("#login-error").hidden = false; }
}

/* ---------- Je suis… ---------- */
function showWhoami() {
  show("whoami");
  renderWhoami();
}
function renderWhoami() {
  const list = $("#whoami-list");
  const cur = lsGet(LS_ME);
  list.innerHTML = state.members.map(m => `
    <button class="whoami-btn ${m.id === cur ? "selected" : ""}" data-id="${esc(m.id)}">
      <span class="dot" style="background:${esc(col(m.color))}"></span>${esc(m.name)}
    </button>`).join("");
  $("#whoami-empty").hidden = state.members.length > 0;
}
$("#whoami-list").addEventListener("click", (e) => {
  const b = e.target.closest(".whoami-btn"); if (!b) return;
  lsSet(LS_ME, b.dataset.id);
  showApp();
  renderAll();
  toast(`Bonjour ${memberById(b.dataset.id)?.name ?? ""} !`);
});
$("#whoami-skip").onclick = () => showApp();
$("#whoami-go-family").onclick = () => { showApp(); setTab("family"); };

/* ---------- Application ---------- */
function showApp() {
  const wasHidden = $("#screen-app").hidden;
  show("app");
  if (wasHidden && state.tab === "calendar") requestAnimationFrame(() => scrollToMonth());
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["calendar", "stays", "family", "settings"]) $("#tab-" + t).hidden = t !== tab;
  $("#year-row").hidden = !(tab === "calendar" || tab === "stays");
  if (tab !== "calendar") cancelSelection();
  window.scrollTo(0, 0);
  if (tab === "calendar") requestAnimationFrame(() => scrollToMonth());
}
document.querySelectorAll(".tabbtn").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

function setYear(y) {
  state.year = y;
  cancelSelection();
  renderAll();
  if (state.tab === "calendar") {
    const now = new Date();
    if (y === now.getFullYear()) scrollToMonth(); else window.scrollTo(0, 0);
  }
}
$("#year-prev").onclick = () => setYear(state.year - 1);
$("#year-next").onclick = () => setYear(state.year + 1);
$("#today-btn").onclick = () => {
  const y = new Date().getFullYear();
  if (state.tab !== "calendar") setTab("calendar");
  if (state.year !== y) { state.year = y; renderAll(); }
  scrollToMonth(true);
};
$("#me-chip").onclick = () => showWhoami();
$("#settings-change-me").onclick = () => showWhoami();

function scrollToMonth(smooth) {
  if (state.year !== new Date().getFullYear()) return;
  const el = document.getElementById("month-" + new Date().getMonth());
  if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

/* ---------- Rendu ---------- */
function renderAll() {
  if (!state.spaceId) return;
  const m = me();
  $("#me-chip").innerHTML = m
    ? `<span class="dot" style="background:${esc(col(m.color))}"></span>${esc(m.name)}`
    : `<span class="dot" style="background:var(--border)"></span>Je suis…`;
  $("#settings-me").textContent = m ? m.name : "Non choisi";
  $("#year-label").textContent = state.year;
  $("#stays-year").textContent = state.year;
  renderLegend();
  renderCalendar();
  renderStays();
  renderMembers();
  if (!$("#screen-whoami").hidden) renderWhoami();
}

function staysByDay(year) {
  const map = new Map();
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const sorted = [...state.stays].sort((a, b) => a.start.localeCompare(b.start));
  for (const s of sorted) {
    if (s.end < yStart || s.start > yEnd) continue;
    let d = s.start < yStart ? yStart : s.start;
    const last = s.end > yEnd ? yEnd : s.end;
    let guard = 0;
    while (d <= last && guard++ < 400) {
      if (!map.has(d)) map.set(d, []);
      const arr = map.get(d);
      for (const [mid, asGuest] of [[s.memberId, false], ...guestIdsOf(s).map(g => [g, true])]) {
        if (!arr.some(x => x.memberId === mid && !x.dup)) arr.push({ memberId: mid, stay: s, asGuest });
        else arr.push({ memberId: mid, stay: s, asGuest, dup: true });
      }
      d = addDays(d, 1);
    }
  }
  return map;
}

function renderLegend() {
  $("#legend").innerHTML = state.members.length
    ? state.members.map(m => `<span class="legend-item"><span class="dot" style="background:${esc(col(m.color))}"></span>${esc(m.name)}</span>`).join("")
    : `<span class="muted">Ajoutez les membres de la famille dans l'onglet « Famille ».</span>`;
}

function renderCalendar() {
  const y = state.year;
  const map = staysByDay(y);
  const today = todayStr();
  const now = new Date();
  let html = "";
  for (let m = 0; m < 12; m++) {
    const first = new Date(Date.UTC(y, m, 1));
    const offset = (first.getUTCDay() + 6) % 7;
    const nDays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let busyDays = 0;
    let cells = "";
    for (let i = 0; i < offset; i++) cells += `<div class="day empty"></div>`;
    for (let d = 1; d <= nDays; d++) {
      const ds = ymd(y, m, d);
      const wd = (offset + d - 1) % 7;
      const here = (map.get(ds) || []).filter(x => !x.dup);
      if (here.length) busyDays++;
      const cls = ["day"];
      if (wd >= 5) cls.push("weekend");
      if (ds === today) cls.push("today");
      if (ds < today) cls.push("past");
      if (here.length) cls.push("busy");
      if (state.selStart === ds) cls.push("sel-start");
      if (here.length) {
        // Pastille continue sur les jours occupés consécutifs (dans la même semaine).
        const prevBusy = wd > 0 && d > 1 && (map.get(ymd(y, m, d - 1)) || []).length;
        const nextBusy = wd < 6 && d < nDays && (map.get(ymd(y, m, d + 1)) || []).length;
        if (!prevBusy) cls.push("rs");
        if (!nextBusy) cls.push("re");
      }
      const shown = here.slice(0, 4);
      const bars = here.length
        ? `<div class="bars">${shown.map(x => `<span style="background:${esc(col(memberById(x.memberId)?.color))}"></span>`).join("")}${here.length > 4 ? `<em>+${here.length - 4}</em>` : ""}</div>`
        : "";
      const label = `${d} ${MONTHS[m]}${here.length ? " : " + here.map(x => memberById(x.memberId)?.name || "?").join(", ") : ""}`;
      cells += `<button class="${cls.join(" ")}" data-date="${ds}" aria-label="${esc(label)}"><span class="num">${d}</span>${bars}</button>`;
    }
    const isCurrent = y === now.getFullYear() && m === now.getMonth();
    html += `
      <section class="month ${isCurrent ? "current" : ""}" id="month-${m}">
        <h2 class="month-title"><span>${cap(MONTHS[m])} ${y}</span>${busyDays ? `<span class="count">${busyDays} j. occupé${busyDays > 1 ? "s" : ""}</span>` : ""}</h2>
        <div class="weekdays">${WEEKDAYS_SHORT.map(w => `<div>${w}</div>`).join("")}</div>
        <div class="days">${cells}</div>
      </section>`;
  }
  $("#calendar").innerHTML = html;
  if (state.firstRender && state.tab === "calendar" && !$("#screen-app").hidden) {
    state.firstRender = false;
    requestAnimationFrame(() => scrollToMonth());
  }
}

function renderStays() {
  const y = state.year;
  const yStart = `${y}-01-01`, yEnd = `${y}-12-31`;
  const today = todayStr();
  const list = state.stays
    .filter(s => !(s.end < yStart || s.start > yEnd))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  if (!list.length) {
    $("#stays-list").innerHTML = `<div class="empty-state">Aucun séjour prévu en ${y}.<br>Touchez un jour dans le calendrier pour en ajouter un.</div>`;
    return;
  }
  let html = "", lastMonth = -1;
  for (const s of list) {
    const mo = s.start < yStart ? 0 : Number(s.start.slice(5, 7)) - 1;
    if (mo !== lastMonth) { html += `<div class="month-group-title">${cap(MONTHS[mo])}</div>`; lastMonth = mo; }
    const mb = memberById(s.memberId);
    html += `
      <button class="stay-item ${s.end < today ? "past" : ""}" data-stay="${esc(s.id)}">
        <span class="stay-color" style="background:${esc(col(mb?.color))}"></span>
        <span class="stay-main">
          <div class="stay-name">${esc(mb?.name || "Personne retirée")}${withText(s) ? ` <span class="stay-with">${esc(withText(s))}</span>` : ""}</div>
          <div class="stay-dates">${esc(rangeText(s.start, s.end))}</div>
          ${s.note ? `<div class="stay-note">${esc(s.note)}</div>` : ""}
        </span>
        <span class="stay-edit" aria-hidden="true">✎</span>
      </button>`;
  }
  $("#stays-list").innerHTML = html;
}
$("#stays-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-stay]"); if (!b) return;
  const s = state.stays.find(x => x.id === b.dataset.stay);
  if (s) openStayEditor(s);
});

/* ---------- Calendrier : sélection ---------- */
$("#calendar").addEventListener("click", (e) => {
  const b = e.target.closest(".day[data-date]"); if (!b) return;
  const ds = b.dataset.date;
  if (state.selStart) {
    let a = state.selStart, z = ds;
    if (z < a) [a, z] = [z, a];
    cancelSelection();
    openStayEditor({ start: a, end: z });
    return;
  }
  const here = (staysByDay(state.year).get(ds) || []);
  if (here.length) openDaySheet(ds, here);
  else beginSelection(ds);
});

function beginSelection(ds) {
  if (!state.members.length) { toast("Ajoutez d'abord les membres dans l'onglet « Famille »."); return; }
  state.selStart = ds;
  $("#select-text").textContent = `Arrivée : ${shortDate(ds)}. Touchez maintenant le jour de départ.`;
  $("#select-banner").hidden = false;
  renderCalendar();
}
function cancelSelection() {
  if (!state.selStart) return;
  state.selStart = null;
  $("#select-banner").hidden = true;
  renderCalendar();
}
$("#select-cancel").onclick = () => cancelSelection();
$("#select-single").onclick = () => {
  const d = state.selStart; cancelSelection();
  if (d) openStayEditor({ start: d, end: d });
};

function openDaySheet(ds, here) {
  // Une ligne par séjour présent ce jour-là (les invités apparaissent dans la ligne de leur hôte).
  const stays = [...new Map(here.map(x => [x.stay.id, x.stay])).values()]
    .sort((p, q) => p.start.localeCompare(q.start));
  const people = new Set(), extNames = new Set();
  for (const s of stays) {
    people.add(memberById(s.memberId) ? s.memberId : "stay:" + s.id);
    guestIdsOf(s).forEach(id => people.add(id));
    guestsOf(s).forEach(n => extNames.add(n.trim().toLowerCase()));
  }
  const total = people.size + extNames.size;
  const lines = stays.map(s => {
    const m = memberById(s.memberId);
    const w = withText(s);
    return `
      <div class="person-line">
        <span class="dot" style="background:${esc(col(m?.color))};width:24px;height:24px"></span>
        <div class="info">
          <strong>${esc(hostName(s))}</strong>${w ? ` <span class="small">${esc(w)}</span>` : ""}
          <div class="small">${esc(rangeText(s.start, s.end))}</div>
          ${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ""}
        </div>
        <button class="btn btn-small" data-edit="${esc(s.id)}">Modifier</button>
      </div>`;
  }).join("");
  openSheet(`
    <h3>${esc(longDate(ds))}</h3>
    <p class="label">À la maison · ${total} personne${total > 1 ? "s" : ""}</p>
    ${lines}
    <div style="height:14px"></div>
    <button class="btn btn-primary btn-block" id="day-add">Ajouter un séjour à partir de ce jour</button>
    <button class="btn btn-ghost btn-block" id="day-close">Fermer</button>`);
  $("#sheet-body").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const s = state.stays.find(x => x.id === b.dataset.edit);
    closeSheet(); if (s) openStayEditor(s);
  });
  $("#day-add").onclick = () => { closeSheet(); beginSelection(ds); };
  $("#day-close").onclick = () => closeSheet();
}

/* ---------- Éditeur de séjour ---------- */
function openStayEditor(stay) {
  if (!state.members.length) { toast("Ajoutez d'abord les membres dans l'onglet « Famille »."); return; }
  const editing = !!stay.id;
  const defaultMember = stay.memberId || me()?.id || state.members[0].id;
  const single = stay.start === stay.end;
  const options = state.members.map(m => `<option value="${esc(m.id)}" ${m.id === defaultMember ? "selected" : ""}>${esc(m.name)}</option>`).join("")
    + (editing && !memberById(stay.memberId) ? `<option value="${esc(stay.memberId)}" selected>Personne retirée</option>` : "");
  openSheet(`
    <h3>${editing ? "Modifier le séjour" : "Nouveau séjour"}</h3>
    <form id="stay-form">
      <label class="label" for="st-member">Qui ?</label>
      <select id="st-member">${options}</select>
      <label class="check-row"><input type="checkbox" id="st-single" ${single ? "checked" : ""}> Un seul jour</label>
      <label class="label" for="st-start" id="st-start-label">${single ? "Jour" : "Arrivée"}</label>
      <input type="date" id="st-start" value="${stay.start}" required>
      <div id="st-end-wrap" ${single ? "hidden" : ""}>
        <label class="label" for="st-end">Départ</label>
        <input type="date" id="st-end" value="${stay.end}">
      </div>
      <div class="summary-box" id="st-summary"></div>
      <div class="label">Voyagez-vous seul ?</div>
      <div class="btn-row solo-row">
        <button type="button" class="btn" id="st-solo-yes" aria-pressed="false">Oui</button>
        <button type="button" class="btn" id="st-solo-no" aria-pressed="false">Non</button>
      </div>
      <div id="st-guests" hidden>
        <div class="label">Avec qui ?</div>
        <div id="st-guest-members"></div>
        <label class="label" for="st-guest-name">Ajouter un invité</label>
        <div class="guest-add">
          <input id="st-guest-name" type="text" maxlength="40" placeholder="Nom de l'invité" autocapitalize="words" enterkeyhint="done">
          <button type="button" class="btn btn-primary" id="st-guest-add" aria-label="Ajouter l'invité">+</button>
        </div>
        <div id="st-guest-chips" class="guest-chips"></div>
      </div>
      <label class="label" for="st-note">Note (facultatif)</label>
      <textarea id="st-note" maxlength="500" placeholder="Ex. : avec les enfants, arrivée le soir…">${esc(stay.note || "")}</textarea>
      <p class="error" id="st-error" hidden></p>
      <div class="btn-row">
        <button type="button" class="btn" id="st-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary" id="st-save">${editing ? "Enregistrer" : "Confirmer"}</button>
      </div>
      ${editing ? `<button type="button" class="btn btn-danger-ghost btn-block" id="st-delete" style="margin-top:12px">Supprimer ce séjour</button>` : ""}
    </form>`);

  const startI = $("#st-start"), endI = $("#st-end"), singleI = $("#st-single");
  const summary = () => {
    const s = startI.value, e = singleI.checked ? s : endI.value;
    const name = $("#st-member").selectedOptions[0]?.textContent || "";
    $("#st-summary").textContent = s && e && e >= s ? `${name} · ${rangeText(s, e)}` : "Dates à compléter";
  };
  singleI.onchange = () => {
    $("#st-end-wrap").hidden = singleI.checked;
    $("#st-start-label").textContent = singleI.checked ? "Jour" : "Arrivée";
    if (!singleI.checked && (!endI.value || endI.value < startI.value)) endI.value = startI.value;
    summary();
  };
  startI.onchange = () => { if (endI.value && endI.value < startI.value) endI.value = startI.value; summary(); };
  endI.onchange = summary;
  // Invités
  const guestIds = new Set(Array.isArray(stay.guestIds) ? stay.guestIds.filter(id => memberById(id)) : []);
  const guests = Array.isArray(stay.guests) ? stay.guests.filter(n => typeof n === "string" && n.trim()) : [];
  let solo = !(guestIds.size || guests.length);
  const renderGuests = () => {
    const host = $("#st-member").value;
    guestIds.delete(host);
    $("#st-solo-yes").className = "btn" + (solo ? " btn-primary" : "");
    $("#st-solo-no").className = "btn" + (solo ? "" : " btn-primary");
    $("#st-solo-yes").setAttribute("aria-pressed", solo);
    $("#st-solo-no").setAttribute("aria-pressed", !solo);
    $("#st-guests").hidden = solo;
    const others = state.members.filter(m => m.id !== host);
    $("#st-guest-members").innerHTML = others.length
      ? others.map(m => `<label class="check-row"><input type="checkbox" data-guest="${esc(m.id)}" ${guestIds.has(m.id) ? "checked" : ""}><span class="dot" style="background:${esc(col(m.color))}"></span>${esc(m.name)}</label>`).join("")
      : `<p class="small muted">Aucun autre profil dans la famille.</p>`;
    $("#st-guest-chips").innerHTML = guests.map((n, i) =>
      `<span class="guest-chip">${esc(n)}<button type="button" data-unguest="${i}" aria-label="Retirer ${esc(n)}">×</button></span>`).join("");
  };
  const addExternal = () => {
    const n = $("#st-guest-name").value.trim().slice(0, 40);
    if (!n) return;
    if (guests.length >= 30) { toast("30 invités au maximum."); return; }
    if (!guests.some(g => g.toLowerCase() === n.toLowerCase())) guests.push(n);
    $("#st-guest-name").value = "";
    renderGuests();
  };
  $("#st-solo-yes").onclick = () => { solo = true; renderGuests(); };
  $("#st-solo-no").onclick = () => { solo = false; renderGuests(); };
  $("#st-guest-members").onchange = (ev) => {
    const c = ev.target.closest("[data-guest]"); if (!c) return;
    c.checked ? guestIds.add(c.dataset.guest) : guestIds.delete(c.dataset.guest);
  };
  $("#st-guest-add").onclick = addExternal;
  $("#st-guest-name").onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); addExternal(); } };
  $("#st-guest-chips").onclick = (ev) => {
    const b = ev.target.closest("[data-unguest]"); if (!b) return;
    guests.splice(Number(b.dataset.unguest), 1); renderGuests();
  };
  $("#st-member").onchange = () => { summary(); renderGuests(); };
  summary();
  renderGuests();

  $("#st-cancel").onclick = () => closeSheet();
  $("#stay-form").onsubmit = async (e) => {
    e.preventDefault();
    const data = {
      memberId: $("#st-member").value,
      start: startI.value,
      end: singleI.checked ? startI.value : endI.value,
      note: $("#st-note").value.trim().slice(0, 500),
      guestIds: [],
      guests: [],
    };
    if (!solo) {
      if ($("#st-guest-name").value.trim()) addExternal(); // nom tapé mais pas encore validé par « + »
      data.guestIds = [...guestIds].filter(id => id !== data.memberId && memberById(id));
      data.guests = guests.slice(0, 30);
    }
    const err = $("#st-error");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.start) || !/^\d{4}-\d{2}-\d{2}$/.test(data.end)) { err.textContent = "Dates incomplètes."; err.hidden = false; return; }
    if (data.end < data.start) { err.textContent = "Le départ doit être après l'arrivée."; err.hidden = false; return; }
    if (daysBetween(data.start, data.end) > 366) { err.textContent = "Séjour trop long (plus d'un an)."; err.hidden = false; return; }
    $("#st-save").disabled = true;
    try {
      // Les écritures sont appliquées tout de suite en local (et synchronisées dès que possible).
      const p = editing ? store.updateStay(state.spaceId, stay.id, data) : store.addStay(state.spaceId, data);
      p.catch(ex => { console.error(ex); toast("Erreur d'enregistrement. Réessayez."); });
      closeSheet();
      toast(editing ? "Séjour modifié" : "Séjour ajouté");
    } catch (ex) {
      console.error(ex);
      err.textContent = "Erreur d'enregistrement."; err.hidden = false;
      $("#st-save").disabled = false;
    }
  };
  if (editing) {
    $("#st-delete").onclick = async () => {
      const name = memberById(stay.memberId)?.name || "cette personne";
      const ok = await confirmBox("Supprimer ce séjour ?", `Séjour de ${name}, ${rangeText(stay.start, stay.end)}. Cette action est définitive.`);
      if (!ok) return;
      store.deleteStay(state.spaceId, stay.id).catch(ex => { console.error(ex); toast("Erreur de suppression."); });
      toast("Séjour supprimé");
    };
  }
}

/* ---------- Famille ---------- */
function renderMembers() {
  const list = $("#members-list");
  list.innerHTML = state.members.length
    ? state.members.map(m => `
      <div class="member-row">
        <span class="dot" style="background:${esc(col(m.color))}"></span>
        <span class="name">${esc(m.name)}</span>
        <button class="btn" data-medit="${esc(m.id)}">Modifier</button>
        <button class="btn btn-danger-ghost" data-mdel="${esc(m.id)}" aria-label="Retirer ${esc(m.name)}">Retirer</button>
      </div>`).join("")
    : `<div class="empty-state">Personne pour l'instant. Ajoutez les membres de la famille ci-dessous.</div>`;
  const used = new Set(state.members.map(m => col(m.color)));
  if (!state.newMemberColor || used.has(state.newMemberColor)) state.newMemberColor = COLORS.find(c => !used.has(c)) || COLORS[state.members.length % COLORS.length];
  $("#member-colors").innerHTML = colorGrid(state.newMemberColor);
}
function colorGrid(selected) {
  return COLORS.map(c => `<button type="button" class="color-swatch ${c === selected ? "selected" : ""}" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join("");
}
$("#member-colors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-color]"); if (!b) return;
  state.newMemberColor = b.dataset.color;
  $("#member-colors").innerHTML = colorGrid(state.newMemberColor);
});
$("#member-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#member-name").value.trim().slice(0, 40);
  if (!name) return;
  if (state.members.some(m => m.name.toLowerCase() === name.toLowerCase())) { toast(`${name} est déjà dans la liste.`); return; }
  const order = state.members.reduce((mx, m) => Math.max(mx, m.order ?? 0), 0) + 1;
  store.addMember(state.spaceId, { name, color: state.newMemberColor, order }).catch(ex => { console.error(ex); toast("Erreur d'ajout."); });
  $("#member-name").value = "";
  toast(`${name} ajouté(e)`);
});
$("#members-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-mdel]");
  const ed = e.target.closest("[data-medit]");
  if (del) {
    const m = memberById(del.dataset.mdel); if (!m) return;
    const theirs = state.stays.filter(s => s.memberId === m.id);
    const ok = await confirmBox(`Retirer ${m.name} ?`,
      theirs.length ? `${m.name} sera retiré(e) de la liste, ainsi que ses ${theirs.length} séjour(s).` : `${m.name} sera retiré(e) de la liste.`, "Retirer");
    if (!ok) return;
    if (lsGet(LS_ME) === m.id) lsSet(LS_ME, null);
    store.removeMember(state.spaceId, m.id, theirs.map(s => s.id)).catch(ex => { console.error(ex); toast("Erreur."); });
    toast(`${m.name} retiré(e)`);
  } else if (ed) {
    const m = memberById(ed.dataset.medit); if (!m) return;
    let color = col(m.color);
    openSheet(`
      <h3>Modifier</h3>
      <form id="medit-form">
        <label class="label" for="me-name">Prénom</label>
        <input id="me-name" maxlength="40" value="${esc(m.name)}" required>
        <div class="label">Couleur</div>
        <div class="color-grid" id="me-colors">${colorGrid(color)}</div>
        <div class="btn-row">
          <button type="button" class="btn" id="me-cancel">Annuler</button>
          <button type="submit" class="btn btn-primary">Enregistrer</button>
        </div>
      </form>`);
    $("#me-colors").onclick = (ev) => {
      const b = ev.target.closest("[data-color]"); if (!b) return;
      color = b.dataset.color; $("#me-colors").innerHTML = colorGrid(color);
    };
    $("#me-cancel").onclick = () => closeSheet();
    $("#medit-form").onsubmit = (ev) => {
      ev.preventDefault();
      const name = $("#me-name").value.trim().slice(0, 40);
      if (!name) return;
      store.updateMember(state.spaceId, m.id, { name, color }).catch(ex => { console.error(ex); toast("Erreur."); });
      closeSheet();
    };
  }
});

/* ---------- Réglages ---------- */
$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const a = $("#code-new").value, b = $("#code-new2").value;
  const err = $("#code-error");
  err.hidden = true;
  if (store.normalizeCode(a) !== store.normalizeCode(b)) { err.textContent = "Les deux codes ne sont pas identiques."; err.hidden = false; return; }
  if (store.normalizeCode(a).length < 8) { err.textContent = "Le code doit contenir au moins 8 lettres ou chiffres."; err.hidden = false; return; }
  const ok = await confirmBox("Changer le code ?", `Le nouveau code sera « ${a.trim()} ». Tous les autres téléphones devront le saisir. Notez-le bien avant de continuer.`, "Changer le code", false);
  if (!ok) return;
  const btn = e.submitter || $("#code-form button[type=submit]");
  btn.disabled = true; btn.textContent = "Changement en cours…";
  try {
    const newId = await store.deriveSpaceId(a);
    if (newId === state.spaceId) throw new Error("same");
    const oldId = state.spaceId;
    if (state.unsub) { state.unsub(); state.unsub = null; }
    await store.moveSpace(oldId, newId);
    lsSet(LS_SPACE, newId);
    $("#code-new").value = ""; $("#code-new2").value = "";
    enterSpace(newId);
    toast("Code changé. Communiquez-le à la famille.");
  } catch (ex) {
    console.error(ex);
    err.textContent = ex.message === "same" ? "C'est déjà le code actuel."
      : ex.message === "exists" ? "Ce code n'est pas disponible, choisissez-en un autre."
        : "Le changement a échoué. Vérifiez votre connexion et réessayez.";
    err.hidden = false;
    if (!state.unsub && state.spaceId) enterSpace(state.spaceId);
  } finally {
    btn.disabled = false; btn.textContent = "Changer le code";
  }
});

$("#logout-btn").onclick = async () => {
  const ok = await confirmBox("Oublier le code ?", "Il faudra saisir à nouveau le code d'accès sur ce téléphone.", "Oublier");
  if (ok) kickOut();
};

/* ---------- Clavier : garder le champ du code visible ---------- */
$("#login-code").addEventListener("focus", () => {
  setTimeout(() => $("#login-form").scrollIntoView({ behavior: "smooth", block: "end" }), 350);
});

/* ---------- Démarrage ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { }));
}
document.addEventListener("visibilitychange", () => {
  // Si l'app reste ouverte plusieurs jours, on rafraîchit « aujourd'hui ».
  if (document.visibilityState === "visible" && state.spaceId) renderCalendar();
});
start();
