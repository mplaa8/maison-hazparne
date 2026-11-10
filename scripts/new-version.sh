#!/bin/sh
# À lancer avant chaque publication qui modifie l'app (HTML, CSS, JS, images).
# Met le même numéro de version dans sw.js et index.html : l'app proposera alors « Mettre à jour ».
set -e
cd "$(dirname "$0")/.."
V="$(date +%Y-%m-%d-%H%M)"
sed -i.bak "s/^const VERSION = \".*\";/const VERSION = \"$V\";/" sw.js
sed -i.bak "s/<meta name=\"app-version\" content=\"[^\"]*\">/<meta name=\"app-version\" content=\"$V\">/" index.html
rm -f sw.js.bak index.html.bak
echo "Version $V"
