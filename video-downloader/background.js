const LOG = "[VD]";
console.log(LOG, "service worker démarré");

const tabData = new Map();
const DIRECT_EXT = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const DIRECT_CONTENT_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];

function getTabEntry(tabId) {
  if (!tabData.has(tabId)) {
    tabData.set(tabId, { direct: new Map(), hls: new Map(), title: "", poster: null });
  }
  return tabData.get(tabId);
}

function extFromUrl(url) {
  const clean = url.split("?")[0].split("#")[0];
  const match = clean.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function classify(url, contentType) {
  const ext = extFromUrl(url);
  const ct = (contentType || "").toLowerCase();
  if (ext === "m3u8" || ct.includes("mpegurl")) return "hls";
  if (ext === "ts" || ct.includes("mp2t")) return null;
  if (DIRECT_EXT.has(ext) || DIRECT_CONTENT_TYPES.some((t) => ct.startsWith(t))) return "direct";
  return null;
}

// Fetching HLS manifests/segments from the service worker fails on CDNs that
// gate access behind Referer/cookie checks (e.g. Akamai token auth), because
// a service-worker fetch carries neither. Instead we ask the content script
// running in the *frame that actually requested the video* to do the fetch,
// so it's indistinguishable from a request made by the real player.
function sendToFrame(tabId, frameId, message) {
  console.log(LOG, `sendToFrame [tab ${tabId}, frame ${frameId}] :`, message);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
      console.log(LOG, `sendToFrame [tab ${tabId}, frame ${frameId}] réponse :`, response, "lastError:", chrome.runtime.lastError?.message);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.error) {
        reject(new Error(response?.error || "pas de réponse de la frame"));
        return;
      }
      resolve(response);
    });
  });
}

function parsePlaylistText(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (!isMaster) return { master: false };

  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
    const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
    const uriLine = lines[i + 1];
    if (uriLine && !uriLine.startsWith("#")) {
      variants.push({
        url: new URL(uriLine.trim(), baseUrl).href,
        bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : null,
        resolution: resMatch ? resMatch[1] : null,
      });
    }
  }
  variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return { master: true, variants };
}

const hlsClassifying = new Set();

function clearHlsClassifying(tabId) {
  const prefix = `${tabId}:`;
  for (const key of hlsClassifying) {
    if (key.startsWith(prefix)) hlsClassifying.delete(key);
  }
}

function ensureHlsClassified(tabId, frameId, url) {
  const key = `${tabId}:${url}`;
  if (hlsClassifying.has(key)) return;
  hlsClassifying.add(key);
  sendToFrame(tabId, frameId, { type: "FETCH_TEXT_IN_FRAME", url })
    .then(({ text }) => {
      const result = parsePlaylistText(text, url);
      const item = getTabEntry(tabId).hls.get(url);
      if (!item) return;
      item.master = !!result.master;
      if (result.master) item.variants = result.variants;
      console.log(LOG, `classification HLS OK (${result.master ? "master" : "media"}) :`, url);
      if (result.master && !item.thumbnail) {
        ensureVideoJsPoster(tabId, frameId, url);
      }
    })
    .catch((e) => {
      console.log(LOG, "ERREUR classification HLS échouée :", url, "-", e.message);
      const item = getTabEntry(tabId).hls.get(url);
      if (item) item.master = false;
    });
}

const hlsThumbnailing = new Set();

function clearHlsThumbnailing(tabId) {
  const prefix = `${tabId}:`;
  for (const key of hlsThumbnailing) {
    if (key.startsWith(prefix)) hlsThumbnailing.delete(key);
  }
}

// video.js keeps the poster URL in its player instance (accessible via the
// public player.poster() API) even after the DOM .vjs-poster element has
// been cleared/hidden once playback starts. Content scripts run in an
// isolated JS world and can't see the page's `window.videojs`, so this has
// to be injected to run in the page's own (MAIN world) context instead.
function ensureVideoJsPoster(tabId, frameId, masterUrl) {
  const key = `${tabId}:${masterUrl}`;
  if (hlsThumbnailing.has(key)) return;
  hlsThumbnailing.add(key);
  chrome.scripting
    .executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: () => {
        try {
          const vjs = window.videojs;
          if (!vjs || !vjs.getPlayer) return { error: "videojs introuvable dans window" };
          for (const el of document.querySelectorAll(".video-js")) {
            const player = vjs.getPlayer(el);
            const url = player && typeof player.poster === "function" ? player.poster() : null;
            if (url) return { poster: new URL(url, location.href).href };
          }
          return { error: "aucun player.poster() non vide" };
        } catch (e) {
          return { error: e.message };
        }
      },
    })
    .then((results) => {
      const result = results && results[0] && results[0].result;
      console.log(LOG, "ensureVideoJsPoster résultat :", result);
      const item = getTabEntry(tabId).hls.get(masterUrl);
      if (item && result && result.poster) item.thumbnail = result.poster;
    })
    .catch((e) => console.log(LOG, "ERREUR ensureVideoJsPoster :", e.message));
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    tabData.set(details.tabId, { direct: new Map(), hls: new Map(), title: "", poster: null });
    clearHlsClassifying(details.tabId);
    clearHlsThumbnailing(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabData.delete(tabId);
  clearHlsClassifying(tabId);
  clearHlsThumbnailing(tabId);
});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const contentLength = headers.find((h) => h.name.toLowerCase() === "content-length")?.value;
    const kind = classify(details.url, contentType);
    if (!kind) return;
    console.log(LOG, `réseau [tab ${details.tabId}, frame ${details.frameId}] ${kind} (${contentType || "?"}, ${contentLength || "?"} o) :`, details.url);
    const entry = getTabEntry(details.tabId);
    if (kind === "direct") {
      if (!entry.direct.has(details.url)) {
        entry.direct.set(details.url, {
          url: details.url,
          size: contentLength ? parseInt(contentLength, 10) : null,
        });
      }
    } else if (!entry.hls.has(details.url)) {
      entry.hls.set(details.url, { url: details.url, master: null, variants: null, frameId: details.frameId });
      ensureHlsClassified(details.tabId, details.frameId, details.url);
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG, `message reçu "${message.type}" de`, sender.url || sender.tab?.url, "frameId:", sender.frameId);
  switch (message.type) {
    case "FOUND_VIDEOS": {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      console.log(LOG, `FOUND_VIDEOS [tab ${tabId}] depuis ${sender.url} :`, message.videos, "poster:", !!message.poster);
      const entry = getTabEntry(tabId);
      if (message.title) entry.title = message.title;
      if (message.poster && !entry.poster) entry.poster = message.poster;
      message.videos.forEach((v) => {
        if (v.kind === "hls") {
          const existing = entry.hls.get(v.url) || { url: v.url, master: null, variants: null, frameId: sender.frameId };
          if (v.thumbnail) existing.thumbnail = v.thumbnail;
          entry.hls.set(v.url, existing);
          if (existing.master === null) ensureHlsClassified(tabId, existing.frameId, v.url);
        } else {
          const existing = entry.direct.get(v.url) || { url: v.url, size: null };
          if (v.thumbnail) existing.thumbnail = v.thumbnail;
          entry.direct.set(v.url, existing);
        }
      });
      return;
    }
    case "GET_VIDEOS": {
      const entry = getTabEntry(message.tabId);
      const hlsList = Array.from(entry.hls.values());
      const masters = hlsList.filter((e) => e.master === true);
      const hls = masters.length ? masters : hlsList.filter((e) => e.master !== false);
      console.log(LOG, `GET_VIDEOS [tab ${message.tabId}] : ${entry.direct.size} direct(s), ${hlsList.length} hls total (${hls.length} retourné(s))`);
      sendResponse({
        title: entry.title,
        poster: entry.poster,
        direct: Array.from(entry.direct.values()),
        hls,
      });
      return true;
    }
    case "PARSE_HLS": {
      sendToFrame(message.tabId, message.frameId, { type: "FETCH_TEXT_IN_FRAME", url: message.url })
        .then(({ text }) => sendResponse(parsePlaylistText(text, message.url)))
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    case "DOWNLOAD_DIRECT": {
      chrome.downloads.download({ url: message.url, filename: message.filename }, (id) => {
        sendResponse({ id, error: chrome.runtime.lastError?.message });
      });
      return true;
    }
    case "DOWNLOAD_HLS": {
      // The blob is assembled and downloaded from inside the content script's
      // frame directly (see content.js) — a service-worker round trip can't
      // carry a whole video through chrome.runtime messaging reliably.
      sendToFrame(message.tabId, message.frameId, {
        type: "DOWNLOAD_HLS_IN_FRAME",
        url: message.url,
        filename: message.filename,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    default:
      return;
  }
});
