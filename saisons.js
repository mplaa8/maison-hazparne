// Bannières de saison : Noël, Pâques, Halloween, 14 juillet.
// Les dessins sont des <template> SVG dans index.html (inline : le trait suit le thème, les textes
// utilisent les polices de l'app). Date du téléphone, heure de Paris, bornes incluses, chaque année.
// Réglage caché pour tester : ?saison=noel | paques | halloween | juillet (ou ?saison=aucune).

const SAISONS = ["noel", "paques", "halloween", "juillet"];

/** Date du jour à Paris, au format AAAA-MM-JJ. */
export function parisToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Dimanche de Pâques (calendrier grégorien), algorithme de Meeus/Butcher. Renvoie AAAA-MM-JJ. */
export function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const shift = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Période de Pâques : du lundi de Pâques − 19 jours au lendemain du lundi de Pâques (inclus). */
export function easterPeriod(y) {
  const monday = shift(easterSunday(y), 1);
  return { start: shift(monday, -19), end: shift(monday, 1) };
}

/** Saison du jour (ou null). */
export function seasonFor(ds) {
  const y = Number(ds.slice(0, 4)), md = ds.slice(5);
  if (md >= "12-01" && md <= "12-26") return "noel";
  if (md >= "10-01" && md <= "10-31") return "halloween";
  if (md === "07-14") return "juillet";
  const p = easterPeriod(y);
  if (ds >= p.start && ds <= p.end) return "paques";
  return null;
}

function forced() {
  try {
    const v = new URLSearchParams(location.search).get("saison");
    if (v == null) return undefined;
    const k = v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return SAISONS.includes(k) ? k : null; // ?saison=aucune (ou inconnu) : rien
  } catch { return undefined; }
}

let shown = undefined;
/** Place (ou retire) la bannière du jour dans les emplacements prévus. */
export function applySeason() {
  const f = forced();
  const s = f !== undefined ? f : seasonFor(parisToday());
  if (s === shown) return;
  shown = s;
  const tpl = s && document.getElementById("saison-" + s);
  document.querySelectorAll("[data-saison-slot]").forEach((slot) => {
    slot.replaceChildren();
    if (tpl) { slot.appendChild(tpl.content.cloneNode(true)); slot.hidden = false; }
    else slot.hidden = true;
  });
}
