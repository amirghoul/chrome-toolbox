# Video Downloader

Détecte les vidéos présentes sur une page (fichiers directs mp4/webm et flux HLS `.m3u8`) et permet de les télécharger en choisissant la qualité.

## Installation (mode développeur)

1. `chrome://extensions`
2. Activer le "Mode développeur"
3. "Charger l'extension non empaquetée" → sélectionner ce dossier

## Fonctionnement

- Un content script détecte les balises `<video>`/`<source>` de la page et capture une miniature (poster de la vidéo, ou une frame via `<canvas>` si aucun poster n'est défini).
- Le service worker écoute aussi les requêtes réseau (types `media`/`xmlhttprequest`/`object`/`other`) pour repérer les fichiers vidéo et manifests HLS chargés dynamiquement — nécessaire car la plupart des lecteurs modernes chargent la vidéo dans `<video>` via une URL `blob:` (MediaSource) qui n'est pas exploitable directement.
- Chaque manifest HLS détecté est analysé dès sa découverte ; seules les playlists "master" (qui listent toutes les qualités) sont affichées dans le popup, pour éviter d'afficher séparément chaque piste/qualité individuelle.
- Le téléchargement d'un flux HLS récupère les segments (5 en parallèle) et les assemble en un seul fichier `.ts`.

## Limitations connues (v1)

- Pas de support DASH (`.mpd`).
- Pas de support des flux HLS chiffrés (`#EXT-X-KEY`).
- Les segments HLS sont assemblés entièrement en mémoire avant le téléchargement — peut être lourd sur de très longues vidéos.
- Si une page n'expose aucune playlist HLS "master" (rare, streams à qualité unique), les playlists individuelles détectées sont affichées telles quelles.
