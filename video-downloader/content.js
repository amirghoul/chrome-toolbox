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

console.log(LOG, "content script chargé sur", location.href, window === window.top ? "(frame principale)" : "(iframe)");
collectVideos();
new MutationObserver(scheduleCollect).observe(document.body, { childList: true, subtree: true });
