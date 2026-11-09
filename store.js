// Accès aux données (Firebase Firestore).
// Toutes les données d'un planning sont rangées sous /spaces/{id}, où {id}
// est une empreinte cryptographique (PBKDF2-SHA256) du code d'accès.
// Sans le code, impossible de connaître ce chemin, et les règles Firestore
// interdisent de lister la collection « spaces ».
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, writeBatch, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export const configured = !String(firebaseConfig.projectId || "").includes("A_REMPLIR");

let db = null;
function getDb() {
  if (db) return db;
  const app = initializeApp(firebaseConfig);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    db = initializeFirestore(app, {});
  }
  return db;
}

const SALT = "maison-hazparne/v1";

export function normalizeCode(code) {
  return String(code || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function deriveSpaceId(code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(normalizeCode(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(SALT), iterations: 150000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const spaceRef = (id) => doc(getDb(), "spaces", id);
const membersCol = (id) => collection(getDb(), "spaces", id, "members");
const staysCol = (id) => collection(getDb(), "spaces", id, "stays");

export async function spaceExists(id) {
  const snap = await getDoc(spaceRef(id));
  return snap.exists();
}

export async function createSpace(id) {
  await setDoc(spaceRef(id), { createdAt: serverTimestamp(), v: 1 });
}

/** Écoute en temps réel. Renvoie une fonction pour arrêter l'écoute. */
export function subscribe(id, { onMembers, onStays, onSpaceGone, onError }) {
  const unsubs = [];
  unsubs.push(onSnapshot(spaceRef(id), (s) => {
    if (!s.exists() && !s.metadata.fromCache) onSpaceGone();
  }, (e) => onError && onError(e)));
  unsubs.push(onSnapshot(membersCol(id), (qs) => {
    onMembers(qs.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (e) => onError && onError(e)));
  unsubs.push(onSnapshot(staysCol(id), (qs) => {
    onStays(qs.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (e) => onError && onError(e)));
  return () => unsubs.forEach(u => u());
}

export function addMember(id, { name, color, order }) {
  return addDoc(membersCol(id), { name, color, order, createdAt: serverTimestamp() });
}
export function updateMember(id, memberId, data) {
  return updateDoc(doc(membersCol(id), memberId), data);
}
export async function removeMember(id, memberId, stayIds) {
  const batch = writeBatch(getDb());
  stayIds.forEach(sid => batch.delete(doc(staysCol(id), sid)));
  batch.delete(doc(membersCol(id), memberId));
  await batch.commit();
}

// Invités : guestIds = profils de la famille, guests = noms d'invités extérieurs.
// Un séjour sans invités n'a pas ces champs (les anciens séjours comptent comme « seul »).
export function addStay(id, { memberId, start, end, note, guestIds = [], guests = [] }) {
  const data = { memberId, start, end, note, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  if (guestIds.length) data.guestIds = guestIds;
  if (guests.length) data.guests = guests;
  return addDoc(staysCol(id), data);
}
export function updateStay(id, stayId, { memberId, start, end, note, guestIds = [], guests = [] }) {
  return updateDoc(doc(staysCol(id), stayId), {
    memberId, start, end, note, updatedAt: serverTimestamp(),
    guestIds: guestIds.length ? guestIds : deleteField(),
    guests: guests.length ? guests : deleteField(),
  });
}
export function deleteStay(id, stayId) {
  return deleteDoc(doc(staysCol(id), stayId));
}

/** Déplace toutes les données vers le chemin dérivé du nouveau code, puis efface l'ancien. */
export async function moveSpace(oldId, newId) {
  if (await spaceExists(newId)) throw new Error("exists");
  // Toutes les collections du planning (y compris le Mémo) suivent le nouveau code.
  // Une collection illisible (ex. règles pas encore à jour) est simplement ignorée.
  const snaps = await Promise.all(ALL_COLLECTIONS.map(c =>
    getDocs(collection(getDb(), "spaces", oldId, c)).then(qs => qs.docs.map(d => ({ col: c, id: d.id, data: d.data() }))).catch(() => [])));
  await createSpace(newId);
  const items = snaps.flat();
  const d = getDb();
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(d);
    items.slice(i, i + 400).forEach(it => batch.set(doc(d, "spaces", newId, it.col, it.id), it.data));
    await batch.commit();
  }
  for (let i = 0; i < items.length; i += 400) {
    const batch = writeBatch(d);
    items.slice(i, i + 400).forEach(it => batch.delete(doc(d, "spaces", oldId, it.col, it.id)));
    await batch.commit();
  }
  await deleteDoc(spaceRef(oldId));
}

/* ---------- Mémo : code wifi, points d'attention, check-lists ---------- */
// Tout est rangé sous /spaces/{id}, comme le planning : rien n'est dans le code source ni dans le dépôt.
const ALL_COLLECTIONS = ["members", "stays", "notes", "checkItems", "checks", "memo", "infos"];
const col = (id, name) => collection(getDb(), "spaces", id, name);

/** Écoute en temps réel du Mémo. onError reçoit l'erreur (ex. règles Firestore pas encore mises à jour). */
export function subscribeMemo(id, { onWifi, onNotes, onItems, onChecks, onInfos, onInfosError, onError }) {
  const err = (e) => onError && onError(e);
  const unsubs = [
    onSnapshot(doc(col(id, "memo"), "wifi"), (s) => onWifi(s.exists() ? s.data() : null), err),
    onSnapshot(col(id, "notes"), (qs) => onNotes(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err),
    onSnapshot(col(id, "checkItems"), (qs) => onItems(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err),
    onSnapshot(col(id, "checks"), (qs) => onChecks(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err),
    // « Bon à savoir » a sa propre erreur : si les règles ne sont pas encore à jour, le reste du Mémo marche quand même.
    onSnapshot(col(id, "infos"), (qs) => onInfos(qs.docs.map(d => ({ id: d.id, ...d.data() }))), (e) => onInfosError && onInfosError(e)),
  ];
  return () => unsubs.forEach(u => u());
}

export function setWifi(id, code, by) {
  return setDoc(doc(col(id, "memo"), "wifi"), { code, updatedBy: by, updatedAt: serverTimestamp() });
}

export function addNote(id, { text, authorId, authorName }) {
  return addDoc(col(id, "notes"), { text, authorId, authorName, resolved: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
export function updateNote(id, noteId, data) {
  return updateDoc(doc(col(id, "notes"), noteId), { ...data, updatedAt: serverTimestamp() });
}
export function deleteNote(id, noteId) { return deleteDoc(doc(col(id, "notes"), noteId)); }

export function addItem(id, { list, text, order }) {
  return addDoc(col(id, "checkItems"), { list, text, order, createdAt: serverTimestamp() });
}
export function updateItem(id, itemId, data) { return updateDoc(doc(col(id, "checkItems"), itemId), data); }
export function deleteItem(id, itemId) { return deleteDoc(doc(col(id, "checkItems"), itemId)); }
export async function swapItems(id, a, b, name = "checkItems") {
  const batch = writeBatch(getDb());
  batch.update(doc(col(id, name), a.id), { order: b.order });
  batch.update(doc(col(id, name), b.id), { order: a.order });
  await batch.commit();
}

/** Fiches « Bon à savoir » : kind « text » (texte libre) ou « contact » (nom, précision, numéros). */
export function addInfo(id, { kind, text, name, phones, order }) {
  return addDoc(col(id, "infos"), { kind, text, name, phones, order, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
export function updateInfo(id, infoId, data) {
  return updateDoc(doc(col(id, "infos"), infoId), { ...data, updatedAt: serverTimestamp() });
}
export function deleteInfo(id, infoId) { return deleteDoc(doc(col(id, "infos"), infoId)); }

/** Coche ou décoche un point. key = identifiant de la liste du séjour (ex. « stay_ABC_depart »). */
export function setCheck(id, key, { list, stayId, itemId, checked, byId, byName }) {
  return setDoc(doc(col(id, "checks"), key), {
    list, stayId: stayId || null, byId: byId || null, byName: byName || null, updatedAt: serverTimestamp(),
    checked: { [itemId]: checked ? true : deleteField() },
  }, { merge: true });
}
export function clearChecks(id, key, { list, stayId, byId, byName }) {
  return setDoc(doc(col(id, "checks"), key), {
    list, stayId: stayId || null, byId: byId || null, byName: byName || null, updatedAt: serverTimestamp(), checked: {},
  });
}
