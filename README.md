# Maison Hazparne

Planning partagé de la maison de famille à Hazparne : chacun indique quand il sera à la maison.

- Application web (PWA) hébergée sur GitHub Pages, données dans Firebase Firestore (offre gratuite).
- Aucun compte : un code d'accès partagé.

## Sécurité

Le code d'accès n'est jamais stocké. L'app en calcule une empreinte (PBKDF2-SHA256, 150 000 itérations)
qui sert de nom au dossier des données : `/spaces/{empreinte}`. Les règles Firestore (`firestore.rules`)
interdisent de lister la collection `spaces` : sans le code, impossible de trouver ou de lire les données.
Changer le code déplace les données vers la nouvelle empreinte et efface l'ancienne.

## Fichiers

- `index.html`, `style.css`, `app.js` : l'interface
- `store.js` : accès à Firestore
- `config.js` : configuration du projet Firebase
- `firestore.rules` : règles à coller dans la console Firebase
- `manifest.webmanifest`, `sw.js`, `icons/` : installation sur l'écran d'accueil

Première installation : ouvrir l'app avec `#creer` à la fin de l'adresse pour créer l'espace avec le code choisi.

## Agenda

L'onglet « Agenda » affiche les événements qui chevauchent un séjour.

- `data/reference.json` : liste de référence des grands événements récurrents (nom, ville, dates, description,
  coordonnées, lien officiel, notoriété de 1 à 5). `confirmed: false` = dates estimées d'après la règle habituelle.
- `data/images.json` + `images/agenda/` : photos libres de droits (Wikimedia Commons), avec auteur et licence.
- `scripts/build-events.mjs` : fusionne la liste de référence avec l'agenda culturel ouvert du Gouvernement basque
  (Kulturklik, `api.euskadi.eus`, sans clé) et écrit `data/events.json` et `data/live/AAAA-MM.json`.
- `.github/workflows/agenda.yml` : relance ce script chaque nuit (GitHub Actions, gratuit).

## Hors connexion

- `sw.js` (service worker) garde l'app en cache : la page HTML vient du réseau d'abord (dernière version
  quand on est en ligne), le reste (CSS, JS, icônes, photos de la maison, polices, SDK Firebase) du cache d'abord.
  Les données de l'Agenda (`data/`) viennent du réseau d'abord, sinon de la dernière copie.
- Les données du planning, du Mémo et des Restos & bars restent lisibles grâce au cache persistant de Firestore ;
  les modifications faites hors ligne partent seules au retour du réseau.
- **Avant chaque publication qui modifie l'app**, lancer `scripts/new-version.sh` : il met le même numéro de
  version dans `sw.js` et `index.html`. Les téléphones verront alors « Nouvelle version disponible · Mettre à jour ».
  (Les mises à jour nocturnes de l'agenda ne touchent que `data/` et n'en ont pas besoin.)

