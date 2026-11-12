// Génère data/calendrier.json : jours fériés (métropole) et vacances scolaires de la zone C.
// Lancé chaque nuit par la GitHub Action « agenda » ; aucune clé n'est nécessaire.
//
// Sources officielles :
//  - Jours fériés : https://calendrier.api.gouv.fr/jours-feries/metropole/AAAA.json
//  - Vacances : jeu de données « fr-en-calendrier-scolaire » de data.education.gouv.fr
//
// Conventions du jeu de données des vacances :
//  - start_date / end_date sont en UTC (ex. « 2027-04-16T22:00:00+00:00 » = samedi 17 avril, 0 h à Paris).
//    Converties en date de Paris : start = premier jour de vacances, end = jour de la REPRISE des cours.
//    Le dernier jour de vacances est donc la veille de end.
//  - Une ligne par académie (Paris, Créteil, Versailles, Montpellier, Toulouse…) et parfois par population
//    (« Élèves », « Enseignants », « - ») : on ignore « Enseignants » et on dédoublonne.
//  - Le « Pont de l'Ascension » est une entrée à part.
// En cas d'échec d'une source, on garde les données précédentes du fichier (jamais de fichier vide).
import fs from "node:fs";

const OUT = "data/calendrier.json";
const ZONE = "Zone C";
const now = new Date();
const Y = now.getUTCFullYear();
const YEARS = [Y - 1, Y, Y + 1, Y + 2];

const previous = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return null; } })();

async function getJson(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "maison-hazparne (calendrier familial)" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/** Date (AAAA-MM-JJ) à Paris d'un instant ISO. */
const parisDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* ---------- Jours fériés ---------- */
async function feries() {
  const out = {};
  for (const y of YEARS) {
    const j = await getJson(`https://calendrier.api.gouv.fr/jours-feries/metropole/${y}.json`);
    for (const [d, n] of Object.entries(j)) out[d] = n;
  }
  if (Object.keys(out).length < YEARS.length * 10) throw new Error("jours fériés incomplets");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/* ---------- Vacances scolaires ---------- */
function niceName(desc) {
  const d = String(desc).trim().replace(/\s+/g, " ");
  if (/^pont/i.test(d)) return "Pont de l'Ascension";
  const m = d.match(/^(?:d[ée]but des )?vacances (de la |de |d'|d’|du )?(.+)$/i);
  if (!m) return null; // « Rentrée scolaire », etc.
  const art = (m[1] || "").toLowerCase().replace("’", "'");
  const what = m[2].toLowerCase().replace(/^toussaint$/, "Toussaint").replace(/^noël$/, "Noël");
  return `Vacances ${art}${what}`;
}
async function vacances() {
  const where = encodeURIComponent(`zones="${ZONE}" AND end_date >= date'${Y - 1}-09-01'`);
  const rows = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const j = await getJson(`https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records?where=${where}&limit=100&offset=${offset}`);
    rows.push(...(j.results || []));
    if (!j.results || j.results.length < 100) break;
  }
  const seen = new Map();
  for (const r of rows) {
    if (/enseignant/i.test(r.population || "")) continue;
    const name = niceName(r.description);
    if (!name || !r.start_date) continue;
    const start = parisDate(r.start_date);
    const reprise = r.end_date ? parisDate(r.end_date) : null;
    const end = reprise ? addDays(reprise, -1) : null;
    if (end && end < start) continue;
    const key = `${name}|${start}`;
    const cur = seen.get(key);
    // Même période dans plusieurs académies : on garde la fin la plus tardive connue.
    if (!cur || (end && (!cur.end || end > cur.end))) seen.set(key, { name, start, end: end || `${start.slice(0, 4)}-08-31`, reprise });
  }
  const list = [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
  if (!list.length) throw new Error("aucune période de vacances");
  return list;
}

const result = { generatedAt: now.toISOString(), zone: "C", sources: {
  feries: "https://calendrier.api.gouv.fr (jours fériés, métropole)",
  vacances: "https://data.education.gouv.fr — fr-en-calendrier-scolaire (zone C)",
}, feries: previous?.feries || {}, vacances: previous?.vacances || [] };
let changed = false;
try { result.feries = await feries(); changed = true; } catch (e) { console.error("Jours fériés : on garde les données précédentes.", e.message); }
try { result.vacances = await vacances(); changed = true; } catch (e) { console.error("Vacances : on garde les données précédentes.", e.message); }
delete result.prototype;

const same = previous && JSON.stringify({ ...previous, generatedAt: 0 }) === JSON.stringify({ ...result, generatedAt: 0 });
if (!changed || same) { console.log("Calendrier : aucun changement."); process.exit(0); }
fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
console.log(`Calendrier : ${Object.keys(result.feries).length} jours fériés, ${result.vacances.length} périodes de vacances.`);
