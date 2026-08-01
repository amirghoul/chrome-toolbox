# Video Downloader

Détecte les vidéos présentes sur une page (fichiers directs mp4/webm et flux HLS `.m3u8`) et permet de les télécharger en choisissant la qualité.

## Installation (mode développeur)

1. `chrome://extensions`
2. Activer le "Mode développeur"
3. "Charger l'extension non empaquetée" → sélectionner ce dossier

## Fonctionnement

- Un content script détecte les balises `<video>`/`<source>` de la page.
- Le service worker écoute aussi les requêtes réseau pour repérer les fichiers vidéo et manifests HLS chargés dynamiquement.
- Pour un flux HLS, le manifest est analysé pour lister les qualités disponibles (résolution/bitrate).
- Le téléchargement d'un flux HLS récupère et assemble les segments en un seul fichier `.ts`.

## Limitations connues (v1)

- Pas de support DASH (`.mpd`).
- Pas de support des flux HLS chiffrés (`#EXT-X-KEY`).
- Téléchargement des segments HLS séquentiel (peut être lent sur les vidéos longues).
- Les vidéos jouées uniquement via `blob:` (MediaSource) ne sont détectées que si la requête réseau sous-jacente (segment/manifest) est capturée par le service worker.
