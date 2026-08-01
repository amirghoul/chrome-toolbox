const LOG = "[VD]";
const observedVideos = new WeakSet();

function classify(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return { url, kind: "hls" };
  return { url, kind: "direct" };
}

function extractVjsPoster(video) {
  // video.js doesn't use the native <video poster>; depending on version it
  // renders its own cover image either as a background-image on a sibling
  // .vjs-poster div, or as an <img> nested inside it.
  const container = video.closest(".video-js") || video.parentElement;
  const posterEl = container && container.querySelector(".vjs-poster");
  console.log(LOG, "DEBUG .vjs-poster :", posterEl ? posterEl.outerHTML.slice(0, 300) : "introuvable (container trouvé=" + !!container + ")");
  if (!posterEl) return null;

  const img = posterEl.querySelector("img");
  if (img && img.src) return img.src;

  const bg = posterEl.style.backgroundImage || getComputedStyle(posterEl).backgroundImage;
  const match = bg && bg.match(/url\(["']?(.*?)["']?\)/);
  return match ? match[1] : null;
}

function captureThumbnail(video) {
  try {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = Math.max(1, Math.round(160 * (video.videoHeight / video.videoWidth)));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch (e) {
    console.log(LOG, "ERREUR capture miniature échouée (probablement CORS)", e.message);
    return null;
  }
}

function attachListeners(video) {
  if (observedVideos.has(video)) return;
  observedVideos.add(video);
  ["loadeddata", "loadedmetadata", "canplay"].forEach((evt) =>
    video.addEventListener(evt, () => collectVideos(), { once: true })
  );
}

function collectVideos() {
  const videoTags = document.querySelectorAll("video");
  const found = [];
  let pagePoster = null;

  videoTags.forEach((video) => {
    attachListeners(video);
    const vjsPoster = extractVjsPoster(video);
    if ((video.poster || vjsPoster) && !pagePoster) pagePoster = video.poster || vjsPoster;
    const thumbnail = video.poster || vjsPoster || captureThumbnail(video);

    const srcs = new Set();
    if (video.currentSrc) srcs.add(video.currentSrc);
    if (video.src) srcs.add(video.src);
    video.querySelectorAll("source").forEach((s) => {
      if (s.src) srcs.add(s.src);
    });
    srcs.forEach((src) => {
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      found.push({ ...classify(src), thumbnail });
    });
  });

  console.log(
    LOG,
    `scan (${window === window.top ? "top" : "iframe"} ${location.hostname}) : ${videoTags.length} balise(s) <video>, ${found.length} src exploitable(s), poster=${!!pagePoster}`
  );

  if (found.length || pagePoster) {
    chrome.runtime
      .sendMessage({ type: "FOUND_VIDEOS", videos: found, title: document.title, poster: pagePoster })
      .then(() => console.log(LOG, "envoyé au background :", found))
      .catch((e) => console.log(LOG, "ERREUR échec sendMessage (service worker inactif ?)", e));
  }
}

let collectScheduled = false;
function scheduleCollect() {
  if (collectScheduled) return;
  collectScheduled = true;
  setTimeout(() => {
    collectScheduled = false;
    collectVideos();
  }, 500);
}

const FETCH_TIMEOUT_MS = 15000;

async function fetchOk(url, label) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const t0 = performance.now();
  console.log(LOG, `fetch → ${label || ""}`, url);
  try {
    const res = await fetch(url, { signal: controller.signal });
    console.log(LOG, `fetch ← ${label || ""} HTTP ${res.status} en ${Math.round(performance.now() - t0)}ms`, url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    if (e.name === "AbortError") {
      console.log(LOG, `ERREUR fetch ✗ ${label || ""} TIMEOUT après ${FETCH_TIMEOUT_MS}ms`, url);
      throw new Error(`timeout après ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    console.log(LOG, `ERREUR fetch ✗ ${label || ""} ${e.message}`, url);
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

const HLS_FRAME_FETCH_CONCURRENCY = 5;

function parseAttributeList(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[m[1]] = val;
  }
  return attrs;
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

function sequenceToIv(seq) {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, seq >>> 0, false);
  return bytes;
}

// #EXT-X-KEY applies to every segment that follows until a new one appears.
// IV defaults to the segment's media sequence number when not given explicitly (RFC 8216 §5.2).
function parseSegments(text, baseUrl) {
  let mediaSequence = 0;
  let currentKey = null;
  const segments = [];
  let segIndex = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1], 10) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributeList(line.slice("#EXT-X-KEY:".length));
      currentKey = !attrs.METHOD || attrs.METHOD === "NONE" ? null : { method: attrs.METHOD, uri: attrs.URI, iv: attrs.IV };
      continue;
    }
    if (line.startsWith("#")) continue;

    const seq = mediaSequence + segIndex;
    segIndex++;
    segments.push({
      url: new URL(line, baseUrl).href,
      key: currentKey
        ? {
            method: currentKey.method,
            uri: new URL(currentKey.uri, baseUrl).href,
            iv: currentKey.iv ? hexToBytes(currentKey.iv) : sequenceToIv(seq),
          }
        : null,
    });
  }
  return segments;
}

const aesKeyCache = new Map();

function getAesKey(uri) {
  if (!aesKeyCache.has(uri)) {
    aesKeyCache.set(
      uri,
      fetchOk(uri, "clé AES")
        .then((res) => res.arrayBuffer())
        .then((raw) => crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]))
    );
  }
  return aesKeyCache.get(uri);
}

async function decryptSegment(buf, keyInfo) {
  if (!keyInfo) return buf;
  if (keyInfo.method !== "AES-128") {
    throw new Error(`méthode de chiffrement non supportée : ${keyInfo.method}`);
  }
  const cryptoKey = await getAesKey(keyInfo.uri);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: keyInfo.iv }, cryptoKey, buf);
}

async function downloadHlsInThisFrame(variantUrl) {
  console.log(LOG, "downloadHlsInThisFrame: étape 1/4 — récupération de la playlist");
  const res = await fetchOk(variantUrl, "playlist");
  const text = await res.text();
  console.log(LOG, `downloadHlsInThisFrame: playlist reçue (${text.length} caractères)`);

  const segments = parseSegments(text, variantUrl);
  console.log(
    LOG,
    `downloadHlsInThisFrame: étape 2/4 — ${segments.length} segment(s), chiffrement=${segments[0]?.key?.method || "aucun"}`
  );
  if (!segments.length) throw new Error("aucun segment trouvé");

  const parts = new Array(segments.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker(workerId) {
    while (nextIndex < segments.length) {
      const i = nextIndex++;
      const seg = segments[i];
      const r = await fetchOk(seg.url, `worker${workerId} segment ${i + 1}/${segments.length}`);
      const raw = await r.arrayBuffer();
      parts[i] = await decryptSegment(raw, seg.key);
      completed++;
      console.log(LOG, `downloadHlsInThisFrame: segment ${i + 1}/${segments.length} OK (${(parts[i].byteLength / 1024).toFixed(0)} Ko)`);
      chrome.runtime.sendMessage({ type: "HLS_PROGRESS", url: variantUrl, done: completed, total: segments.length }).catch(() => {});
    }
  }
  console.log(LOG, "downloadHlsInThisFrame: étape 3/4 — démarrage des téléchargements de segments");
  await Promise.all(Array.from({ length: Math.min(HLS_FRAME_FETCH_CONCURRENCY, segments.length) }, (_, idx) => worker(idx)));

  console.log(LOG, "downloadHlsInThisFrame: étape 4/4 — assemblage du blob");
  return new Blob(parts, { type: "video/mp2t" });
}

function loadHiddenVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;";

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("timeout décodage (segment probablement non lisible nativement)"));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeoutId);
      video.remove();
      URL.revokeObjectURL(url);
    };

    video.addEventListener("loadeddata", () => resolve({ video, cleanup }), { once: true });
    video.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("décodage impossible : " + (video.error?.message || "erreur inconnue")));
      },
      { once: true }
    );

    video.src = url;
    document.body.appendChild(video);
    video.play().catch(() => {});
  });
}

async function extractThumbnailFromFirstSegment(variantUrl) {
  const res = await fetchOk(variantUrl, "thumb-playlist");
  const text = await res.text();
  const segments = parseSegments(text, variantUrl);
  if (!segments.length) throw new Error("aucun segment pour la miniature");

  const seg = segments[0];
  const r = await fetchOk(seg.url, "thumb-segment");
  const raw = await r.arrayBuffer();
  const decrypted = await decryptSegment(raw, seg.key);
  const blob = new Blob([decrypted], { type: "video/mp2t" });

  const { video, cleanup } = await loadHiddenVideo(blob);
  try {
    if (!video.videoWidth) throw new Error("dimensions vidéo indisponibles après décodage");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = Math.max(1, Math.round(160 * (video.videoHeight / video.videoWidth)));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } finally {
    cleanup();
  }
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG, `message reçu "${message.type}" dans cette frame (${location.href})`, message);
  if (message.type === "FETCH_TEXT_IN_FRAME") {
    fetchOk(message.url, "classification")
      .then((res) => res.text())
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (message.type === "FETCH_HLS_THUMBNAIL_IN_FRAME") {
    console.log(LOG, "tentative de miniature via 1er segment :", message.url);
    extractThumbnailFromFirstSegment(message.url)
      .then((thumbnail) => {
        console.log(LOG, "miniature via segment : OK");
        sendResponse({ thumbnail });
      })
      .catch((e) => {
        console.log(LOG, "ERREUR miniature via segment :", e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }
  if (message.type === "DOWNLOAD_HLS_IN_FRAME") {
    console.log(LOG, "téléchargement HLS depuis cette frame :", message.url);
    downloadHlsInThisFrame(message.url)
      .then((blob) => {
        console.log(LOG, `blob assemblé (${(blob.size / 1024 / 1024).toFixed(1)} Mo), déclenchement du téléchargement`);
        triggerBlobDownload(blob, message.filename);
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.log(LOG, "ERREUR téléchargement HLS échoué dans la frame :", e.message, e);
        sendResponse({ error: e.message });
      });
    return true;
  }
  return undefined;
});

console.log(LOG, "content script chargé sur", location.href, window === window.top ? "(frame principale)" : "(iframe)");
collectVideos();
new MutationObserver(scheduleCollect).observe(document.body, { childList: true, subtree: true });
