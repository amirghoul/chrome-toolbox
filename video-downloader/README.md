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
- La lecture des manifests et le téléchargement des segments (5 en parallèle) se font **depuis le content script, dans la frame qui a chargé la vidéo** (pas depuis le service worker) : beaucoup de CDN vidéo protègent leurs URLs signées par un contrôle du `Referer`/cookies qu'un `fetch()` fait depuis le service worker ne peut pas reproduire correctement. Exécuter la requête dans la vraie frame du lecteur la rend indiscernable d'une requête normale du lecteur. Les segments assemblés sont renvoyés au service worker sous forme de `data:` URL pour déclencher `chrome.downloads.download`.

## Limitations connues (v1)

- Pas de support DASH (`.mpd`).
- Pas de support des flux HLS chiffrés (`#EXT-X-KEY`).
- Les segments HLS sont assemblés entièrement en mémoire (dans l'onglet) avant le téléchargement — peut être lourd sur de très longues vidéos, et la conversion en `data:` URL ajoute ~33% de mémoire en plus le temps du transfert vers le service worker.
- Si une page n'expose aucune playlist HLS "master" (rare, streams à qualité unique), les playlists individuelles détectées sont affichées telles quelles.
- Si un CDN protège aussi via l'IP ou un cookie non accessible à l'extension, le téléchargement peut encore échouer (HTTP 401/403) malgré le relais par frame.
