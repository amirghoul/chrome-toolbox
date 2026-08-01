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
    console.warn(LOG, "capture miniature échouée (probablement CORS)", e.message);
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
      .catch((e) => console.warn(LOG, "échec sendMessage (service worker inactif ?)", e));
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

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const HLS_FRAME_FETCH_CONCURRENCY = 5;

async function downloadHlsInThisFrame(variantUrl) {
  const res = await fetchOk(variantUrl);
  const text = await res.text();
  if (/#EXT-X-KEY/.test(text) && !/METHOD=NONE/.test(text)) {
    throw new Error("flux chiffré non supporté");
  }
  const segmentUrls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, variantUrl).href);

  if (!segmentUrls.length) throw new Error("aucun segment trouvé");

  const parts = new Array(segmentUrls.length);
  let nextIndex = 0;
  let completed = 0;
  async function worker() {
    while (nextIndex < segmentUrls.length) {
      const i = nextIndex++;
      const r = await fetchOk(segmentUrls[i]);
      parts[i] = await r.arrayBuffer();
      completed++;
      chrome.runtime.sendMessage({ type: "HLS_PROGRESS", url: variantUrl, done: completed, total: segmentUrls.length }).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(HLS_FRAME_FETCH_CONCURRENCY, segmentUrls.length) }, worker));

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
    fetchOk(message.url)
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
        console.warn(LOG, "téléchargement HLS échoué dans la frame :", e.message);
        sendResponse({ error: e.message });
      });
    return true;
  }
  return undefined;
});

console.log(LOG, "content script chargé sur", location.href, window === window.top ? "(frame principale)" : "(iframe)");
collectVideos();
new MutationObserver(scheduleCollect).observe(document.body, { childList: true, subtree: true });
