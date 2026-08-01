const LOG = "[VD]";
const observedVideos = new WeakSet();

function classify(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return { url, kind: "hls" };
  return { url, kind: "direct" };
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
    if (video.poster && !pagePoster) pagePoster = video.poster;
    const thumbnail = video.poster || captureThumbnail(video);

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

async function downloadHlsInThisFrame(variantUrl) {
  console.log(LOG, "downloadHlsInThisFrame: étape 1/4 — récupération de la playlist");
  const res = await fetchOk(variantUrl, "playlist");
  const text = await res.text();
  console.log(LOG, `downloadHlsInThisFrame: playlist reçue (${text.length} caractères)`);

  if (/#EXT-X-KEY/.test(text) && !/METHOD=NONE/.test(text)) {
    throw new Error("flux chiffré non supporté");
  }
  const segmentUrls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, variantUrl).href);

  console.log(LOG, `downloadHlsInThisFrame: étape 2/4 — ${segmentUrls.length} segment(s) à télécharger, premier :`, segmentUrls[0]);
  if (!segmentUrls.length) throw new Error("aucun segment trouvé");

  const parts = new Array(segmentUrls.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker(workerId) {
    while (nextIndex < segmentUrls.length) {
      const i = nextIndex++;
      const r = await fetchOk(segmentUrls[i], `worker${workerId} segment ${i + 1}/${segmentUrls.length}`);
      const buf = await r.arrayBuffer();
      parts[i] = buf;
      completed++;
      console.log(LOG, `downloadHlsInThisFrame: segment ${i + 1}/${segmentUrls.length} OK (${(buf.byteLength / 1024).toFixed(0)} Ko)`);
      chrome.runtime.sendMessage({ type: "HLS_PROGRESS", url: variantUrl, done: completed, total: segmentUrls.length }).catch(() => {});
    }
  }
  console.log(LOG, "downloadHlsInThisFrame: étape 3/4 — démarrage des téléchargements de segments");
  await Promise.all(Array.from({ length: Math.min(HLS_FRAME_FETCH_CONCURRENCY, segmentUrls.length) }, (_, idx) => worker(idx)));

  console.log(LOG, "downloadHlsInThisFrame: étape 4/4 — assemblage du blob");
  return new Blob(parts, { type: "video/mp2t" });
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
