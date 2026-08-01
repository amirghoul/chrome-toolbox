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

const hlsClassifying = new Set();

function ensureHlsClassified(tabId, url) {
  const key = `${tabId}:${url}`;
  if (hlsClassifying.has(key)) return;
  hlsClassifying.add(key);
  parseHlsPlaylist(url)
    .then((result) => {
      const item = getTabEntry(tabId).hls.get(url);
      if (!item) return;
      item.master = !!result.master;
      if (result.master) item.variants = result.variants;
    })
    .catch(() => {
      const item = getTabEntry(tabId).hls.get(url);
      if (item) item.master = false;
    });
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    tabData.set(details.tabId, { direct: new Map(), hls: new Map(), title: "", poster: null });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabData.delete(tabId));

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = details.responseHeaders || [];
    const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const contentLength = headers.find((h) => h.name.toLowerCase() === "content-length")?.value;
    const kind = classify(details.url, contentType);
    if (!kind) return;
    const entry = getTabEntry(details.tabId);
    if (kind === "direct") {
      if (!entry.direct.has(details.url)) {
        entry.direct.set(details.url, {
          url: details.url,
          size: contentLength ? parseInt(contentLength, 10) : null,
        });
      }
    } else if (!entry.hls.has(details.url)) {
      entry.hls.set(details.url, { url: details.url, master: null, variants: null });
      ensureHlsClassified(details.tabId, details.url);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function parseHlsPlaylist(url) {
  const res = await fetch(url);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (!isMaster) {
    return { master: false };
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
    const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
    const uriLine = lines[i + 1];
    if (uriLine && !uriLine.startsWith("#")) {
      variants.push({
        url: new URL(uriLine.trim(), url).href,
        bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : null,
        resolution: resMatch ? resMatch[1] : null,
      });
    }
  }
  variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return { master: true, variants };
}

async function downloadHlsVariant(variantUrl, filename, onProgress) {
  const res = await fetch(variantUrl);
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

  const parts = [];
  for (let i = 0; i < segmentUrls.length; i++) {
    const segRes = await fetch(segmentUrls[i]);
    parts.push(await segRes.arrayBuffer());
    onProgress(i + 1, segmentUrls.length);
  }

  const blob = new Blob(parts, { type: "video/mp2t" });
  const blobUrl = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        URL.revokeObjectURL(blobUrl);
        reject(new Error(chrome.runtime.lastError?.message || "échec du téléchargement"));
        return;
      }
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state) {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(blobUrl);
          resolve(downloadId);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "FOUND_VIDEOS": {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      const entry = getTabEntry(tabId);
      if (message.title) entry.title = message.title;
      if (message.poster && !entry.poster) entry.poster = message.poster;
      message.videos.forEach((v) => {
        if (v.kind === "hls") {
          const existing = entry.hls.get(v.url) || { url: v.url, master: null, variants: null };
          if (v.thumbnail) existing.thumbnail = v.thumbnail;
          entry.hls.set(v.url, existing);
          if (existing.master === null) ensureHlsClassified(tabId, v.url);
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
      sendResponse({
        title: entry.title,
        poster: entry.poster,
        direct: Array.from(entry.direct.values()),
        hls,
      });
      return true;
    }
    case "PARSE_HLS": {
      parseHlsPlaylist(message.url)
        .then(sendResponse)
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
      downloadHlsVariant(message.url, message.filename, (done, total) => {
        chrome.runtime.sendMessage({ type: "HLS_PROGRESS", url: message.url, done, total }).catch(() => {});
      })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    default:
      return;
  }
});
