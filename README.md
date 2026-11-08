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
