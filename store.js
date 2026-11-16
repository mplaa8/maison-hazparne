// Accès aux données (Firebase Firestore).
// Toutes les données d'un planning sont rangées sous /spaces/{id}, où {id}
// est une empreinte cryptographique (PBKDF2-SHA256) du code d'accès.
// Sans le code, impossible de connaître ce chemin, et les règles Firestore
// interdisent de lister la collection « spaces ».
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, setDoc as fsSetDoc, addDoc as fsAddDoc, updateDoc as fsUpdateDoc, deleteDoc as fsDeleteDoc,
  onSnapshot as fsOnSnapshot, writeBatch as fsWriteBatch, serverTimestamp, deleteField, query, where, waitForPendingWrites,
  increment, arrayUnion, arrayRemove, getAggregateFromServer, count, sum
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export const configured = !String(firebaseConfig.projectId || "").includes("A_REMPLIR");

/* ---------- Hors connexion ----------
   Le cache persistant de Firestore (IndexedDB, multi-onglets) garde les données déjà chargées et
   met en file les écritures faites hors ligne ; elles partent seules au retour du réseau.
   Ici on note seulement l'heure de la dernière réception du serveur et les écritures faites hors ligne. */
const LS_SYNC = "mh.lastSync", LS_PENDING = "mh.offlineWrites";
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } } };
let lastSync = Number(ls.get(LS_SYNC)) || null;
export const lastSyncTime = () => lastSync;
function noteServer(meta) {
  if (meta && !meta.fromCache && navigator.onLine) { lastSync = Date.now(); ls.set(LS_SYNC, String(lastSync)); }
}
function track(promise) {
  if (!navigator.onLine) ls.set(LS_PENDING, "1");
  return promise;
}
export const hasOfflineWrites = () => ls.get(LS_PENDING) === "1";
/** Résout quand toutes les écritures en attente ont été reçues par le serveur. */
export async function whenSynced() {
  await waitForPendingWrites(getDb());
  const had = hasOfflineWrites();
  ls.set(LS_PENDING, null);
  lastSync = Date.now(); ls.set(LS_SYNC, String(lastSync));
  return had;
}
const setDoc = (...a) => track(fsSetDoc(...a));
const addDoc = (...a) => track(fsAddDoc(...a));
const updateDoc = (...a) => track(fsUpdateDoc(...a));
const deleteDoc = (...a) => track(fsDeleteDoc(...a));
function writeBatch(d) { const b = fsWriteBatch(d); const commit = b.commit.bind(b); b.commit = () => track(commit()); return b; }
/** onSnapshot qui note aussi l'heure des données reçues du serveur. */
function onSnapshot(ref, next, error) {
  return fsOnSnapshot(ref, (s) => { noteServer(s.metadata); next(s); }, error);
}

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
  // Lots de 400 documents au plus et d'environ 5 Mo au plus (les photos sont lourdes).
  const chunks = [];
  let cur = [], bytes = 0;
  for (const it of items) {
    const size = JSON.stringify(it.data).length;
    if (cur.length && (cur.length >= 400 || bytes + size > 5e6)) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += size;
  }
  if (cur.length) chunks.push(cur);
  for (const c of chunks) {
    const batch = writeBatch(d);
    c.forEach(it => batch.set(doc(d, "spaces", newId, it.col, it.id), it.data));
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
const ALL_COLLECTIONS = ["members", "stays", "notes", "checkItems", "checks", "memo", "infos", "places", "ratings", "placePhotos", "placePhotoFull",
  "albums", "albumEvents", "albumPhotos", "albumPhotoFull", "settings"];
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

/* ---------- Restos & bars : adresses, notes, photos ---------- */
// Photos : pas de Firebase Storage. Chaque photo est compressée dans le navigateur puis rangée dans
// deux documents Firestore : « placePhotos » (miniature, pour les galeries) et « placePhotoFull »
// (photo complète, chargée seulement à l'ouverture). Même identifiant pour les deux.

/** Écoute des adresses et des notes (léger : seule la miniature de couverture est dans l'adresse). */
export function subscribePlaces(id, { onPlaces, onRatings, onError }) {
  const err = (e) => onError && onError(e);
  const unsubs = [
    onSnapshot(col(id, "places"), (qs) => onPlaces(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err),
    onSnapshot(col(id, "ratings"), (qs) => onRatings(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err),
  ];
  return () => unsubs.forEach(u => u());
}
/** Miniatures d'une adresse, en temps réel. */
export function subscribePlacePhotos(id, placeId, onPhotos, onError) {
  return onSnapshot(query(col(id, "placePhotos"), where("placeId", "==", placeId)),
    (qs) => onPhotos(qs.docs.map(d => ({ id: d.id, ...d.data() }))), (e) => onError && onError(e));
}
export async function getPhotoFull(id, photoId) {
  const s = await getDoc(doc(col(id, "placePhotoFull"), photoId));
  return s.exists() ? s.data().data : null;
}

/** Crée l'adresse et renvoie tout de suite son identifiant (l'écriture part dès que possible, même hors ligne). */
export function addPlace(id, data) {
  const ref = doc(col(id, "places"));
  const done = setDoc(ref, { ...data, coverId: null, cover: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  return { id: ref.id, done };
}
export function updatePlace(id, placeId, data) {
  return updateDoc(doc(col(id, "places"), placeId), { ...data, updatedAt: serverTimestamp() });
}
/** Supprime l'adresse avec ses notes et ses photos. */
export async function deletePlace(id, placeId) {
  const d = getDb();
  const [r, p] = await Promise.all([
    getDocs(query(col(id, "ratings"), where("placeId", "==", placeId))),
    getDocs(query(col(id, "placePhotos"), where("placeId", "==", placeId))),
  ]);
  const refs = [...r.docs.map(x => x.ref), ...p.docs.flatMap(x => [x.ref, doc(col(id, "placePhotoFull"), x.id)])];
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(d);
    refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
  await deleteDoc(doc(col(id, "places"), placeId));
}

/** Note d'un membre : un seul document par personne et par adresse (identifiant fixe). */
export function setRating(id, { placeId, memberId, memberName, stars, comment }) {
  return setDoc(doc(col(id, "ratings"), `${placeId}_${memberId}`),
    { placeId, memberId, memberName, stars, comment, updatedAt: serverTimestamp() });
}
export function deleteRating(id, placeId, memberId) { return deleteDoc(doc(col(id, "ratings"), `${placeId}_${memberId}`)); }

/** Enregistre une photo (miniature + complète). Si l'adresse n'a pas de couverture, elle le devient. */
export async function addPhoto(id, { placeId, thumb, full, authorId, authorName, setCover }) {
  const d = getDb();
  const ref = doc(col(id, "placePhotos"));
  const batch = writeBatch(d);
  batch.set(doc(col(id, "placePhotoFull"), ref.id), { placeId, data: full });
  // bytes : taille des deux documents, pour la jauge « Place disponible » des Réglages.
  batch.set(ref, { placeId, thumb, authorId, authorName, bytes: thumb.length + full.length, createdAt: serverTimestamp() });
  if (setCover) batch.update(doc(col(id, "places"), placeId), { coverId: ref.id, cover: thumb, updatedAt: serverTimestamp() });
  await batch.commit();
  return ref.id;
}
export async function deletePhoto(id, placeId, photoId, nextCover) {
  const batch = writeBatch(getDb());
  batch.delete(doc(col(id, "placePhotos"), photoId));
  batch.delete(doc(col(id, "placePhotoFull"), photoId));
  if (nextCover !== undefined) {
    batch.update(doc(col(id, "places"), placeId), { coverId: nextCover?.id || null, cover: nextCover?.thumb || null, updatedAt: serverTimestamp() });
  }
  await batch.commit();
}
export function setCover(id, placeId, photo) {
  return updateDoc(doc(col(id, "places"), placeId), { coverId: photo.id, cover: photo.thumb, updatedAt: serverTimestamp() });
}

/* ---------- Album : photos de famille ----------
   albums/{albumId}        : « stay_<idSéjour> » (un album par séjour, créé à la première utilisation)
                             ou « souvenirs » (Souvenirs d'autrefois). Titre, couverture, compteurs.
   albumEvents/{id}        : événement dans un album (titre, date, couverture, compteur).
   albumPhotos/{id}        : miniature + infos (auteur, dates, légende, événement).
   albumPhotoFull/{id}     : photo complète, chargée seulement à l'ouverture. */
export function subscribeAlbums(id, onAlbums, onError) {
  return onSnapshot(col(id, "albums"), (qs) => onAlbums(qs.docs.map(d => ({ id: d.id, ...d.data() }))), (e) => onError && onError(e));
}
export function subscribeAlbumContent(id, albumId, { onEvents, onPhotos, onError }) {
  const err = (e) => onError && onError(e);
  const u1 = onSnapshot(query(col(id, "albumEvents"), where("albumId", "==", albumId)), (qs) => onEvents(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err);
  const u2 = onSnapshot(query(col(id, "albumPhotos"), where("albumId", "==", albumId)), (qs) => onPhotos(qs.docs.map(d => ({ id: d.id, ...d.data() }))), err);
  return () => { u1(); u2(); };
}
export async function getAlbum(id, albumId) {
  const s = await getDoc(doc(col(id, "albums"), albumId));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function getAlbumThumb(id, photoId) {
  const s = await getDoc(doc(col(id, "albumPhotos"), photoId));
  return s.exists() ? s.data().thumb : null;
}
export async function getAlbumFull(id, photoId) {
  const s = await getDoc(doc(col(id, "albumPhotoFull"), photoId));
  return s.exists() ? s.data().data : null;
}
/** Crée ou complète l'album (fusion). */
export function saveAlbum(id, albumId, data) {
  return setDoc(doc(col(id, "albums"), albumId), { ...data, updatedAt: serverTimestamp() }, { merge: true });
}
export function addAlbumEvent(id, albumId, albumBase, { title, date, authorId, authorName }) {
  const ref = doc(col(id, "albumEvents"));
  const b = writeBatch(getDb());
  b.set(doc(col(id, "albums"), albumId), { ...albumBase, updatedAt: serverTimestamp() }, { merge: true });
  b.set(ref, { albumId, title, date, authorId, authorName, count: 0, coverId: null, cover: null, createdAt: serverTimestamp() });
  return { id: ref.id, done: b.commit() };
}
export function updateAlbumEvent(id, eventId, data) { return updateDoc(doc(col(id, "albumEvents"), eventId), data); }
/** Supprime l'événement ; ses photos reviennent dans l'album du séjour. */
export async function deleteAlbumEvent(id, eventId, photoIds) {
  const refs = [...photoIds];
  for (let i = 0; i < Math.max(1, refs.length); i += 400) {
    const b = writeBatch(getDb());
    refs.slice(i, i + 400).forEach(pid => b.update(doc(col(id, "albumPhotos"), pid), { eventId: null }));
    if (i + 400 >= refs.length) b.delete(doc(col(id, "albumEvents"), eventId));
    await b.commit();
  }
}
export function addAlbumPhoto(id, p, { albumBase, albumCover, preview, eventCover }) {
  const ref = doc(col(id, "albumPhotos"));
  const bytes = p.thumb.length + p.full.length;
  const b = writeBatch(getDb());
  b.set(doc(col(id, "albumPhotoFull"), ref.id), { albumId: p.albumId, data: p.full });
  b.set(ref, { albumId: p.albumId, eventId: p.eventId || null, thumb: p.thumb, authorId: p.authorId, authorName: p.authorName,
    takenAt: p.takenAt || null, srcSize: p.srcSize || 0, caption: "", bytes, createdAt: serverTimestamp() });
  const a = { ...albumBase, count: increment(1), bytes: increment(bytes), updatedAt: serverTimestamp() };
  if (albumCover) Object.assign(a, { coverId: ref.id, cover: p.thumb });
  if (preview) a.previews = arrayUnion(ref.id);
  b.set(doc(col(id, "albums"), p.albumId), a, { merge: true });
  if (p.eventId) {
    const e = { count: increment(1) };
    if (eventCover) Object.assign(e, { coverId: ref.id, cover: p.thumb });
    b.update(doc(col(id, "albumEvents"), p.eventId), e);
  }
  return { id: ref.id, done: b.commit() };
}
export function updateAlbumPhoto(id, photoId, data) { return updateDoc(doc(col(id, "albumPhotos"), photoId), data); }
/** Déplace une photo entre le séjour (eventId null) et un événement. */
export function moveAlbumPhoto(id, photo, toEventId, { fromEventCover, toEventCover }) {
  const b = writeBatch(getDb());
  b.update(doc(col(id, "albumPhotos"), photo.id), { eventId: toEventId || null });
  if (photo.eventId) {
    const e = { count: increment(-1) };
    if (fromEventCover !== undefined) Object.assign(e, { coverId: fromEventCover?.id || null, cover: fromEventCover?.thumb || null });
    b.update(doc(col(id, "albumEvents"), photo.eventId), e);
  }
  if (toEventId) {
    const e = { count: increment(1) };
    if (toEventCover) Object.assign(e, { coverId: photo.id, cover: photo.thumb });
    b.update(doc(col(id, "albumEvents"), toEventId), e);
  }
  return b.commit();
}
export function deleteAlbumPhoto(id, photo, { albumCover, eventCover }) {
  const b = writeBatch(getDb());
  b.delete(doc(col(id, "albumPhotos"), photo.id));
  b.delete(doc(col(id, "albumPhotoFull"), photo.id));
  const a = { count: increment(-1), bytes: increment(-(photo.bytes || 0)), previews: arrayRemove(photo.id), updatedAt: serverTimestamp() };
  if (albumCover !== undefined) Object.assign(a, { coverId: albumCover?.id || null, cover: albumCover?.thumb || null });
  b.update(doc(col(id, "albums"), photo.albumId), a);
  if (photo.eventId) {
    const e = { count: increment(-1) };
    if (eventCover !== undefined) Object.assign(e, { coverId: eventCover?.id || null, cover: eventCover?.thumb || null });
    b.update(doc(col(id, "albumEvents"), photo.eventId), e);
  }
  return b.commit();
}
/** Supprime un album entier : photos, événements, album. */
export async function deleteAlbumAll(id, albumId) {
  const [ph, ev] = await Promise.all([
    getDocs(query(col(id, "albumPhotos"), where("albumId", "==", albumId))),
    getDocs(query(col(id, "albumEvents"), where("albumId", "==", albumId))),
  ]);
  const refs = [...ph.docs.flatMap(x => [x.ref, doc(col(id, "albumPhotoFull"), x.id)]), ...ev.docs.map(x => x.ref)];
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(getDb());
    refs.slice(i, i + 400).forEach(r => b.delete(r));
    await b.commit();
  }
  await deleteDoc(doc(col(id, "albums"), albumId));
}

/* ---------- Mode administrateur ----------
   Le code administrateur n'est jamais stocké : seule son empreinte (PBKDF2) est dans Firestore. */
export async function deriveAdminHash(id, code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(normalizeCode(code)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("maison-hazparne/admin/" + id), iterations: 150000 }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function getAdminHash(id) {
  const s = await getDoc(doc(col(id, "settings"), "admin"));
  return s.exists() ? s.data().hash : null;
}
export function setAdminHash(id, hash) {
  return setDoc(doc(col(id, "settings"), "admin"), { hash, updatedAt: serverTimestamp() });
}

/* ---------- Place utilisée par les photos (Album + Restos & bars) ---------- */
// Requêtes d'agrégation : quelques lectures seulement, quel que soit le nombre de photos.
export async function photoUsage(id) {
  const [a, p, pb] = await Promise.all([
    getAggregateFromServer(col(id, "albumPhotos"), { n: count(), b: sum("bytes") }),
    getAggregateFromServer(col(id, "placePhotos"), { n: count(), b: sum("bytes") }),
    getAggregateFromServer(query(col(id, "placePhotos"), where("bytes", ">", 0)), { n: count() }),
  ]);
  const n = a.data().n + p.data().n;
  let bytes = (a.data().b || 0) + (p.data().b || 0);
  const known = a.data().n + pb.data().n;
  // Anciennes photos des Restos & bars sans taille enregistrée : on compte la moyenne des autres.
  const avg = known ? bytes / known : 230000;
  bytes += (n - known) * avg;
  return { count: n, bytes };
}

