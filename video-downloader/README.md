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
- La lecture des manifests et le téléchargement des segments (5 en parallèle) se font **depuis le content script, dans la frame qui a chargé la vidéo** (pas depuis le service worker) : beaucoup de CDN vidéo protègent leurs URLs signées par un contrôle du `Referer`/cookies qu'un `fetch()` fait depuis le service worker ne peut pas reproduire correctement. Exécuter la requête dans la vraie frame du lecteur la rend indiscernable d'une requête normale du lecteur.
- Le fichier assemblé (`Blob`) est téléchargé **directement depuis cette frame** via un `<a download>` synthétique, sans jamais transiter par le service worker — `chrome.runtime.sendMessage` a une limite de taille qui rend le transfert d'une vidéo entière (encodée en base64) peu fiable.
- Les segments chiffrés en AES-128 (`#EXT-X-KEY:METHOD=AES-128`, courant sur les plateformes de cours type Hotmart) sont déchiffrés à la volée via l'API Web Crypto : la clé est récupérée une fois (et mise en cache) depuis l'URI du tag, l'IV vient du tag ou par défaut du numéro de séquence du segment (RFC 8216 §5.2).

## Limitations connues (v1)

- Pas de support DASH (`.mpd`).
- Pas de support de `SAMPLE-AES` (chiffrement HLS pour segments fMP4) ni d'autres méthodes que `AES-128`.
- Les segments HLS sont assemblés entièrement en mémoire (dans l'onglet) avant le téléchargement — peut être lourd sur de très longues vidéos.
- Si une page n'expose aucune playlist HLS "master" (rare, streams à qualité unique), les playlists individuelles détectées sont affichées telles quelles.
- Si un CDN protège aussi via l'IP ou un cookie non accessible à l'extension, le téléchargement peut encore échouer (HTTP 401/403) malgré le relais par frame.
- Si la frame d'origine a été déchargée entre-temps (navigation, lecture auto de la vidéo suivante), le relais échoue — il faut rouvrir le popup pour redétecter sur la frame actuelle.
