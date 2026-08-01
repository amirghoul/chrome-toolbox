const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const downloadUrlByBtn = new WeakMap();

const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="#e5e7eb"/><polygon points="26,20 26,44 46,32" fill="#9ca3af"/></svg>'
  );

function sanitize(name) {
  return (name || "video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "video";
  }
}

function buildCard({ thumbnail, badge, title }) {
  const root = document.createElement("div");
  root.className = "item";
  root.innerHTML = `
    <img class="thumb" src="${thumbnail || PLACEHOLDER_THUMB}" />
    <div class="info">
      <span class="badge">${badge}</span>
      <div class="title" title="${title}">${title}</div>
      <select class="quality-select" hidden></select>
      <div class="item-meta"></div>
    </div>
    <button class="download-btn">Télécharger</button>
  `;
  root.querySelector(".thumb").onerror = function () {
    this.src = PLACEHOLDER_THUMB;
  };
  return {
    root,
    select: root.querySelector(".quality-select"),
    meta: root.querySelector(".item-meta"),
    btn: root.querySelector(".download-btn"),
  };
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "GET_VIDEOS", tabId: tab.id }, (data) => render(tab, data));
}

function render(tab, data) {
  listEl.innerHTML = "";
  const total = data.direct.length + data.hls.length;
  statusEl.textContent = total ? `${total} vidéo(s) détectée(s)` : "Aucune vidéo détectée sur cette page";
  const host = hostname(tab.url);

  data.direct.forEach((v) => {
    const ext = (v.url.split("?")[0].match(/\.([a-z0-9]+)$/i) || [, "mp4"])[1].toLowerCase();
    const card = buildCard({ thumbnail: v.thumbnail || data.poster, badge: ext.toUpperCase(), title: `${host}.${ext}` });
    card.meta.textContent = formatSize(v.size);
    card.btn.addEventListener("click", () => {
      card.btn.disabled = true;
      const filename = `${sanitize(host)}.${ext}`;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_DIRECT", url: v.url, filename }, (res) => {
        const failed = !res || res.error;
        card.btn.textContent = failed ? "Erreur" : "OK";
        card.btn.disabled = !failed;
      });
    });
    listEl.appendChild(card.root);
  });

  data.hls.forEach((v) => {
    const card = buildCard({ thumbnail: v.thumbnail || data.poster, badge: "HLS", title: `${host}.ts` });
    listEl.appendChild(card.root);

    const useVariants = (variants) => {
      card.meta.textContent = "";
      card.select.hidden = false;
      card.select.innerHTML = variants
        .map(
          (variant, i) =>
            `<option value="${i}">${variant.resolution || (variant.bandwidth ? Math.round(variant.bandwidth / 1000) + " kbps" : "Qualité unique")}</option>`
        )
        .join("");
      card.btn.disabled = false;
      card.btn.addEventListener("click", () => {
        const variant = variants[Number(card.select.value)];
        card.btn.disabled = true;
        card.btn.textContent = "...";
        downloadUrlByBtn.set(card.btn, variant.url);
        const filename = `${sanitize(host)}.ts`;
        chrome.runtime.sendMessage({ type: "DOWNLOAD_HLS", url: variant.url, filename, referrer: v.referrer }, (res) => {
          const failed = !res || res.error;
          card.btn.textContent = failed ? "Erreur" : "OK";
          card.btn.disabled = !failed;
        });
      });
    };

    if (v.master && v.variants) {
      useVariants(v.variants);
    } else {
      card.meta.textContent = "Chargement des qualités...";
      card.btn.disabled = true;
      chrome.runtime.sendMessage({ type: "PARSE_HLS", url: v.url, referrer: v.referrer }, (result) => {
        if (result.error) {
          card.meta.textContent = "Erreur: " + result.error;
          return;
        }
        useVariants(result.master ? result.variants : [{ url: v.url }]);
      });
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "HLS_PROGRESS") return;
  document.querySelectorAll(".download-btn").forEach((btn) => {
    if (downloadUrlByBtn.get(btn) === message.url) {
      btn.textContent = `${message.done}/${message.total}`;
    }
  });
});

init();
