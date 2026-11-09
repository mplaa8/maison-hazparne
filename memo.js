// Onglet « Mémo » : code wifi, points d'attention, check-lists « En arrivant » / « En partant ».
// Toutes les données viennent de Firestore (sous le chemin secret du planning) : aucune n'est dans le code.
import * as store from "./store.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const LIST_NAMES = { arrive: "En arrivant", depart: "En partant" };

let ctx = null;
const memo = { wifi: null, notes: [], items: [], checks: [], loaded: false, error: false };
const ui = { list: "arrive", editing: false, showResolved: false, copied: false };
let unsub = null;

function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function dm(s) { const d = parse(s); return `${d.getUTCDate()}${d.getUTCDate() === 1 ? "er" : ""} ${MONTHS[d.getUTCMonth()]}`; }
function dateOf(ts) {
  const d = ts?.toDate ? ts.toDate() : (typeof ts === "number" ? new Date(ts) : null);
  return d ? `${d.getDate()}${d.getDate() === 1 ? "er" : ""} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}` : "";
}

/* ---------- Données ---------- */
export function startMemo(spaceId) {
  if (unsub) unsub();
  Object.assign(memo, { wifi: null, notes: [], items: [], checks: [], loaded: false, error: false });
  unsub = store.subscribeMemo(spaceId, {
    onWifi: (w) => { memo.wifi = w; memo.loaded = true; update(); },
    onNotes: (n) => { memo.notes = n; update(); },
    onItems: (i) => { memo.items = i; update(); },
    onChecks: (c) => { memo.checks = c; update(); },
    onError: (e) => { console.error(e); memo.error = true; update(); },
  });
}
export function stopMemo() { if (unsub) { unsub(); unsub = null; } }

export function openNotesCount() { return memo.notes.filter(n => !n.resolved).length; }

function update() {
  ctx.onBadge(openNotesCount());
  if (ctx.state.tab === "memo") renderMemo();
}

/** Séjour auquel les coches sont liées : séjour en cours du profil, sinon le prochain. */
function currentStay() {
  const meId = ctx.me()?.id;
  if (!meId) return null;
  const today = ctx.todayStr();
  const mine = ctx.state.stays.filter(s => s.memberId === meId || (Array.isArray(s.guestIds) && s.guestIds.includes(meId)));
  return mine.find(s => s.start <= today && s.end >= today)
    || mine.filter(s => s.start > today).sort((a, b) => a.start.localeCompare(b.start))[0]
    || null;
}
function checkKey(list) {
  const s = currentStay();
  return s ? { key: `stay_${s.id}_${list}`, stayId: s.id, stay: s } : { key: `free_${ctx.me()?.id || "tous"}_${list}`, stayId: null, stay: null };
}
const itemsOf = (list) => memo.items.filter(i => i.list === list).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.text).localeCompare(b.text));

/** Dernier départ : liste « En partant » du séjour terminé le plus récemment. */
function lastDeparture() {
  const today = ctx.todayStr();
  const total = itemsOf("depart");
  let best = null;
  for (const c of memo.checks) {
    if (c.list !== "depart" || !c.stayId) continue;
    const s = ctx.state.stays.find(x => x.id === c.stayId);
    if (!s || s.end > today) continue;
    if (!best || s.end > best.stay.end) best = { stay: s, check: c };
  }
  if (!best) return null;
  const done = total.filter(i => best.check.checked?.[i.id]).length;
  const who = best.check.byName || ctx.memberById(best.stay.memberId)?.name || "Quelqu'un";
  return `Dernier départ : ${who}, le ${dm(best.stay.end)}, ${done} / ${total.length} points faits`;
}

/* ---------- Rendu ---------- */
export function renderMemo() {
  const root = $("#memo-root");
  if (!root) return;
  if (memo.error) {
    root.innerHTML = `<div class="card"><p><strong>Le Mémo n'est pas encore activé.</strong></p>
      <p class="small muted">Les règles de sécurité Firestore doivent être mises à jour, puis l'app rouverte.</p></div>`;
    return;
  }
  root.innerHTML = wifiCard() + notesSection() + checklistSection();
}

function wifiCard() {
  const code = memo.wifi?.code || "";
  return `
    <section class="card memo-wifi">
      <div class="memo-card-head">
        <div class="label">Code wifi</div>
        ${code ? `<button class="icon-btn small-icon" data-act="wifi-edit" aria-label="Modifier le code wifi">✎</button>` : ""}
      </div>
      ${code
        ? `<div class="wifi-code" id="wifi-code">${esc(code)}</div>
           <button class="btn btn-primary btn-block" data-act="wifi-copy">${ui.copied ? "Copié ✓" : "Copier"}</button>`
        : `<button class="btn btn-block" data-act="wifi-edit">${memo.loaded ? "Ajouter le code wifi" : "Chargement…"}</button>`}
    </section>`;
}

function notesSection() {
  const open = memo.notes.filter(n => !n.resolved).sort((a, b) => (b.createdAt?.seconds ?? 9e9) - (a.createdAt?.seconds ?? 9e9));
  const done = memo.notes.filter(n => n.resolved).sort((a, b) => (b.resolvedAt?.seconds ?? 0) - (a.resolvedAt?.seconds ?? 0));
  const note = (n) => `
    <div class="note-card ${n.resolved ? "resolved" : ""}">
      <span class="note-dot" aria-hidden="true"></span>
      <div class="note-main">
        <p class="note-text">${esc(n.text)}</p>
        <p class="note-meta">${esc(n.authorName || "Quelqu'un")}${dateOf(n.createdAt) ? " · " + esc(dateOf(n.createdAt)) : ""}${n.resolved ? " · résolu" : ""}</p>
        <div class="note-actions">
          <button class="link-btn" data-act="note-toggle" data-id="${esc(n.id)}">${n.resolved ? "Rouvrir" : "Résolu ✓"}</button>
          <button class="link-btn" data-act="note-edit" data-id="${esc(n.id)}">Modifier</button>
          <button class="link-btn danger" data-act="note-del" data-id="${esc(n.id)}">Supprimer</button>
        </div>
      </div>
    </div>`;
  return `
    <section class="memo-section">
      <h3 class="memo-title">Points d'attention</h3>
      ${open.length ? open.map(note).join("") : `<p class="small muted memo-empty">Aucun point d'attention en cours.</p>`}
      <button class="btn btn-block memo-add" data-act="note-add">+ Ajouter un point d'attention</button>
      ${done.length ? `<button class="link-btn memo-resolved-toggle" data-act="resolved-toggle">${ui.showResolved ? "Masquer les points résolus" : `Voir les points résolus (${done.length})`}</button>` : ""}
      ${ui.showResolved ? done.map(note).join("") : ""}
    </section>`;
}

function checklistSection() {
  const list = ui.list;
  const items = itemsOf(list);
  const { key, stay } = checkKey(list);
  const check = memo.checks.find(c => c.id === key);
  const isChecked = (i) => !!check?.checked?.[i.id];
  const done = items.filter(isChecked).length;
  const pct = items.length ? Math.round(done / items.length * 100) : 0;
  const context = stay
    ? `Séjour ${stay.start <= ctx.todayStr() ? "en cours" : "à venir"} du ${dm(stay.start)} au ${dm(stay.end)}`
    : (ctx.me() ? "Aucun séjour prévu : liste libre" : "Choisissez votre profil pour lier la liste à votre séjour");
  const info = list === "arrive" ? lastDeparture() : null;
  const rows = items.map((i, k) => `
    <li class="check-item ${isChecked(i) ? "checked" : ""}">
      <button class="check-circle" data-act="check" data-id="${esc(i.id)}" role="checkbox" aria-checked="${isChecked(i)}" aria-label="${esc(i.text)}"><span aria-hidden="true">✓</span></button>
      <span class="check-text">${esc(i.text)}</span>
      ${ui.editing ? `
        <span class="check-tools">
          <button class="tool-btn" data-act="item-up" data-id="${esc(i.id)}" ${k === 0 ? "disabled" : ""} aria-label="Monter">↑</button>
          <button class="tool-btn" data-act="item-down" data-id="${esc(i.id)}" ${k === items.length - 1 ? "disabled" : ""} aria-label="Descendre">↓</button>
          <button class="tool-btn" data-act="item-edit" data-id="${esc(i.id)}" aria-label="Modifier">✎</button>
          <button class="tool-btn danger" data-act="item-del" data-id="${esc(i.id)}" aria-label="Supprimer">✕</button>
        </span>` : ""}
    </li>`).join("");
  return `
    <section class="memo-section">
      <h3 class="memo-title">Check-lists</h3>
      <div class="segmented" role="group" aria-label="Choisir la check-list">
        ${["arrive", "depart"].map(l => `<button type="button" class="${l === list ? "active" : ""}" data-act="list" data-list="${l}" aria-pressed="${l === list}">${LIST_NAMES[l]}</button>`).join("")}
      </div>
      <p class="small muted check-context">${esc(context)}</p>
      ${info ? `<p class="check-info">${esc(info)}</p>` : ""}
      <div class="progress-row">
        <div class="progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <span class="progress-label">${done} / ${items.length}</span>
      </div>
      ${list === "depart" && items.length && done === items.length ? `<p class="check-done">Maison bien fermée, merci !</p>` : ""}
      ${items.length ? `<ul class="check-list">${rows}</ul>` : `<p class="small muted memo-empty">${memo.loaded ? "Liste vide." : "Chargement…"}</p>`}
      <button class="btn btn-block memo-add" data-act="item-add">+ Ajouter un point</button>
      <div class="check-footer">
        <button class="link-btn" data-act="edit-mode">${ui.editing ? "Terminer" : "Modifier la liste"}</button>
        <button class="link-btn" data-act="uncheck-all" ${done ? "" : "disabled"}>Tout décocher</button>
      </div>
    </section>`;
}

/* ---------- Actions ---------- */
function textSheet(title, label, value, okLabel, max, onOk) {
  ctx.openSheet(`
    <h3>${esc(title)}</h3>
    <form id="memo-form">
      <label class="label" for="memo-input">${esc(label)}</label>
      <textarea id="memo-input" maxlength="${max}" rows="3" required>${esc(value || "")}</textarea>
      <div class="btn-row">
        <button type="button" class="btn" id="memo-cancel">Annuler</button>
        <button type="submit" class="btn btn-primary">${esc(okLabel)}</button>
      </div>
    </form>`);
  const input = $("#memo-input");
  setTimeout(() => input.focus(), 100);
  $("#memo-cancel").onclick = () => ctx.closeSheet();
  $("#memo-form").onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim().slice(0, max);
    if (!v && max !== 100) return;
    ctx.closeSheet(); onOk(v);
  };
}
const fail = (ex) => { console.error(ex); ctx.toast("Erreur d'enregistrement. Réessayez."); };

async function copyWifi() {
  const code = memo.wifi?.code || "";
  try { await navigator.clipboard.writeText(code); }
  catch {
    const r = document.createRange(); const el = $("#wifi-code");
    if (el) { r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); s.removeAllRanges(); }
  }
  ui.copied = true; renderMemo(); ctx.toast("Copié");
  setTimeout(() => { ui.copied = false; if (ctx.state.tab === "memo") renderMemo(); }, 2000);
}

async function onClick(e) {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const id = b.dataset.id, sid = ctx.state.spaceId, meM = ctx.me();
  switch (b.dataset.act) {
    case "wifi-copy": return copyWifi();
    case "wifi-edit":
      return textSheet(memo.wifi?.code ? "Modifier le code wifi" : "Ajouter le code wifi", "Code wifi", memo.wifi?.code, "Enregistrer", 100,
        (v) => store.setWifi(sid, v, meM?.name || null).catch(fail));
    case "note-add":
      return textSheet("Nouveau point d'attention", "Que faut-il savoir ?", "", "Ajouter", 1000,
        (v) => store.addNote(sid, { text: v, authorId: meM?.id || null, authorName: meM?.name || null }).catch(fail));
    case "note-edit": {
      const n = memo.notes.find(x => x.id === id); if (!n) return;
      return textSheet("Modifier le point d'attention", "Texte", n.text, "Enregistrer", 1000, (v) => store.updateNote(sid, id, { text: v }).catch(fail));
    }
    case "note-toggle": {
      const n = memo.notes.find(x => x.id === id); if (!n) return;
      store.updateNote(sid, id, n.resolved ? { resolved: false, resolvedAt: null } : { resolved: true, resolvedAt: new Date() }).catch(fail);
      return ctx.toast(n.resolved ? "Point rouvert" : "Point marqué comme résolu");
    }
    case "note-del": {
      const n = memo.notes.find(x => x.id === id); if (!n) return;
      if (await ctx.confirmBox("Supprimer ce point d'attention ?", `« ${n.text.slice(0, 120)} »`)) store.deleteNote(sid, id).catch(fail);
      return;
    }
    case "resolved-toggle": ui.showResolved = !ui.showResolved; return renderMemo();
    case "list": ui.list = b.dataset.list; return renderMemo();
    case "edit-mode": ui.editing = !ui.editing; return renderMemo();
    case "check": {
      const { key, stayId } = checkKey(ui.list);
      const cur = !!memo.checks.find(c => c.id === key)?.checked?.[id];
      return store.setCheck(sid, key, { list: ui.list, stayId, itemId: id, checked: !cur, byId: meM?.id, byName: meM?.name }).catch(fail);
    }
    case "uncheck-all": {
      const { key, stayId } = checkKey(ui.list);
      return store.clearChecks(sid, key, { list: ui.list, stayId, byId: meM?.id, byName: meM?.name }).catch(fail);
    }
    case "item-add": {
      const items = itemsOf(ui.list);
      const order = items.reduce((m, i) => Math.max(m, i.order ?? 0), 0) + 1;
      // Une ligne = un point : on peut coller une liste entière d'un coup.
      return textSheet(`Ajouter un point – ${LIST_NAMES[ui.list]}`, "Texte (un point par ligne)", "", "Ajouter", 5000, (v) => {
        const lines = v.split(/\r?\n/).map(l => l.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, "").trim().slice(0, 200)).filter(Boolean).slice(0, 50);
        Promise.all(lines.map((text, n) => store.addItem(sid, { list: ui.list, text, order: order + n })))
          .then(() => { if (lines.length > 1) ctx.toast(`${lines.length} points ajoutés`); }).catch(fail);
      });
    }
    case "item-edit": {
      const it = memo.items.find(x => x.id === id); if (!it) return;
      return textSheet("Modifier le point", "Texte", it.text, "Enregistrer", 200, (v) => store.updateItem(sid, id, { text: v }).catch(fail));
    }
    case "item-del": {
      const it = memo.items.find(x => x.id === id); if (!it) return;
      if (await ctx.confirmBox("Supprimer ce point ?", `« ${it.text} »`)) store.deleteItem(sid, id).catch(fail);
      return;
    }
    case "item-up": case "item-down": {
      const items = itemsOf(ui.list); const k = items.findIndex(x => x.id === id);
      const j = b.dataset.act === "item-up" ? k - 1 : k + 1;
      if (k < 0 || j < 0 || j >= items.length) return;
      const a = items[k], c = items[j];
      if ((a.order ?? 0) !== (c.order ?? 0)) return store.swapItems(sid, a, c).catch(fail);
      // Ordres égaux : on renumérote toute la liste dans le nouvel ordre.
      const next = items.slice(); next[k] = c; next[j] = a;
      return Promise.all(next.map((x, n) => (x.order === n + 1 ? null : store.updateItem(sid, x.id, { order: n + 1 })))).catch(fail);
    }
  }
}

export function initMemo(context) {
  ctx = context;
  $("#memo-root").addEventListener("click", onClick);
}
