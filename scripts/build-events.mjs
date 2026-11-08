// Génère data/events.json à partir de :
//  1) data/reference.json : liste de référence des grands événements (tenue à la main) ;
//  2) l'agenda culturel ouvert du Gouvernement basque (Kulturklik, api.euskadi.eus, sans clé)
//     pour les grandes villes proches. Si cette source ne répond pas, on garde la liste de référence seule.
// Utilisation : node scripts/build-events.mjs   (Node 18 ou plus récent, aucune dépendance)
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const ref = JSON.parse(await readFile(new URL("data/reference.json", ROOT), "utf8"));
const images = JSON.parse(await readFile(new URL("data/images.json", ROOT), "utf8").catch(() => "{}"));

const API = "https://api.euskadi.eus/culture/events/v1.0/events";
// Villes couvertes par l'agenda ouvert (codes NORA : province / commune)
const CITIES = [
  { prov: "20", mun: "82", city: "Donostia – Saint-Sébastien", note: 2 },
  { prov: "48", mun: "167", city: "Bilbao", note: 2 },
  { prov: "31", mun: "476", city: "Pampelune – Iruñea", note: 2 },
  { prov: "1", mun: "46", city: "Vitoria-Gasteiz", note: 1 },
  { prov: "20", mun: "101", city: "Irun", note: 1 },
  { prov: "20", mun: "97", city: "Hondarribia", note: 1 },
];
// Types gardés (on écarte formations, conférences, expositions permanentes…)
const KEEP_TYPES = new Set(["Concierto", "Festival", "Danza", "Teatro", "Eventos/jornadas", "Fiestas", "Bertsolarismo"]);
const MONTHS_AHEAD = 7;

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = iso(today);

const NAMED = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»",
  ordf: "ª", ordm: "º", euro: "€", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", middot: "·", deg: "°" };
const MARKS = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", cedil: "\u0327" };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z])(acute|grave|circ|uml|tilde|cedil);/gi, (_, l, m) => (l + MARKS[m.toLowerCase()]).normalize("NFC"))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? " ");
}
function stripHtml(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function short(s, n = 160) {
  s = stripHtml(s);
  return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s;
}

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "MaisonHazparne/1.0 (github.com/mplaa8/maison-hazparne)" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) { /* nouvel essai */ }
    await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
  }
  throw new Error("Échec : " + url);
}

async function liveEvents() {
  const out = new Map();
  for (const c of CITIES) {
    for (let k = 0; k < MONTHS_AHEAD; k++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + k, 1));
      let page = 1, pages = 1;
      do {
        const url = `${API}/byMonth/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/byMunicipality/${c.prov}/${c.mun}?_elements=100&_page=${page}`;
        const j = await getJson(url);
        if (!j) break;
        pages = j.totalPages || 1;
        for (const it of j.items || []) {
          if (!KEEP_TYPES.has(it.typeEs)) continue;
          const start = String(it.startDate || "").slice(0, 10), end = String(it.endDate || it.startDate || "").slice(0, 10);
          if (!start || end < todayIso) continue;
          const days = (Date.parse(end) - Date.parse(start)) / 86400000;
          if (days > 31) continue; // expositions et cycles très longs
          const name = stripHtml(it.nameEs || it.nameEu).replace(/^Entradas\s+/i, "");
          const key = name.toLowerCase() + "|" + start;
          if (out.has(key)) continue;
          out.set(key, {
            id: "kk-" + it.id,
            name,
            city: c.city,
            lat: Number(it.municipalityLatitude) || null,
            lon: Number(it.municipalityLongitude) || null,
            note: c.note,
            url: it.urlEventEs || it.sourceUrlEs || "https://www.kulturklik.euskadi.eus",
            description: short(it.descriptionEs || it.descriptionEu),
            lang: "es",
            category: it.typeEs,
            place: stripHtml(it.establishmentEs || ""),
            start, end, confirmed: true,
            source: "kulturklik",
          });
        }
        page++;
      } while (page <= pages && page <= 10);
    }
  }
  return [...out.values()].sort((a, b) => a.start.localeCompare(b.start));
}

const reference = [];
for (const e of ref.events) {
  for (const d of e.dates) {
    if (d.end < todayIso) continue;
    const { dates, ...rest } = e;
    reference.push({
      ...rest, start: d.start, end: d.end, confirmed: !!d.confirmed, source: "reference",
      image: images[e.id] || null,
      webcam: ref.webcams?.[e.city] || null,
    });
  }
}

let live = [], liveError = null;
try { live = await liveEvents(); } catch (e) { liveError = String(e.message || e); }

// L'agenda ouvert est découpé en un fichier par mois (data/live/AAAA-MM.json) :
// l'app ne télécharge que les mois qui chevauchent le séjour choisi.
const byMonth = new Map();
for (const e of live) {
  let d = new Date(e.start.slice(0, 7) + "-01T00:00:00Z");
  const last = e.end.slice(0, 7);
  while (iso(d).slice(0, 7) <= last) {
    const k = iso(d).slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(e);
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
}
if (!liveError) {
  await rm(new URL("data/live/", ROOT), { recursive: true, force: true });
  await mkdir(new URL("data/live/", ROOT), { recursive: true });
  for (const [k, list] of byMonth) {
    await writeFile(new URL(`data/live/${k}.json`, ROOT), JSON.stringify(list) + "\n");
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  home: ref.home,
  tourismOffice: ref.tourismOffice,
  sources: {
    reference: reference.length,
    kulturklik: live.length,
    kulturklikError: liveError,
  },
  liveMonths: liveError ? (await readFile(new URL("data/events.json", ROOT), "utf8").then(t => JSON.parse(t).liveMonths || []).catch(() => [])) : [...byMonth.keys()].sort(),
  events: reference,
};
await writeFile(new URL("data/events.json", ROOT), JSON.stringify(result, null, 1) + "\n");
console.log(`events.json : ${reference.length} événements de référence ; Kulturklik : ${live.length} événements sur ${byMonth.size} mois${liveError ? " (erreur : " + liveError + ")" : ""}`);
