# Video Downloader

Détecte les vidéos présentes sur une page (fichiers directs mp4/webm et flux HLS `.m3u8`) et permet de les télécharger en choisissant la qualité.

## Installation (mode développeur)

1. `chrome://extensions`
2. Activer le "Mode développeur"
3. "Charger l'extension non empaquetée" → sélectionner ce dossier

## Fonctionnement

- Un content script détecte les balises `<video>`/`<source>` de la page et capture une miniature : poster natif ou `.vjs-poster` (video.js) en priorité, sinon une frame de la vidéo en cours de lecture via `<canvas>` (fonctionne même pour les lecteurs MediaSource/`blob:`, puisque le canvas n'est pas "tainted" dans ce cas), sinon la balise `<meta property="og:image">` de la page en dernier recours.
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
- La miniature capturée via `<canvas>` nécessite que la vidéo ait commencé à jouer (quelques secondes) avant l'ouverture du popup ; sinon on retombe sur `og:image` ou le placeholder générique.

## Compatibilité testée

| Type de vidéo | Statut | Testé sur |
|---|---|---|
| Fichier direct non protégé (mp4/webm) | ✅ fonctionne | w3schools.com |
| Flux HLS non chiffré, multi-qualité | ✅ fonctionne | Apple bipbop / Mux test streams |
| Flux HLS chiffré AES-128 (segments `.ts`) | ✅ fonctionne | learn.cantrill.io (lecteur Hotmart) |
| Flux DASH (`.mpd`) | ❌ non supporté | — |
| HLS `SAMPLE-AES` (fMP4 chiffré) | ❌ non supporté | — |
| Vidéo avec vraie DRM (Widevine/FairPlay) | ❌ hors scope | protection légale, volontairement pas contournée |
| Remux en `.mp4` | ➖ non fait par choix | fichiers livrés en `.ts`, lisibles tels quels dans VLC/mpv |

## Versions

Les tags git `video-downloader-vX.Y.Z` marquent une version dont le fonctionnement de bout en bout (détection → sélection de qualité → téléchargement, y compris déchiffrement si besoin) a été vérifié manuellement sur au moins un site réel — pas de CI automatisée pour l'instant, donc un tag est la seule garantie qu'"à cet état précis, ça marchait".

- `video-downloader-v1.0.0` — première version fonctionnelle de bout en bout : fichiers directs, HLS non chiffré et HLS AES-128 (voir tableau ci-dessus).
- `video-downloader-v1.1.0` — miniatures fonctionnelles pour les lecteurs MediaSource (poster/`.vjs-poster`/frame capturée/`og:image`, avec la bonne priorité) ; noms de fichiers cohérents entre le popup et le téléchargement réel.
