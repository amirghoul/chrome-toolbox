const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");

function sanitize(name) {
  return (name || "video").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "GET_VIDEOS", tabId: tab.id }, (data) => {
    render(tab, data);
  });
}

function render(tab, data) {
  listEl.innerHTML = "";
  const total = data.direct.length + data.hls.length;
  statusEl.textContent = total ? `${total} vidéo(s) détectée(s)` : "Aucune vidéo détectée sur cette page";

  data.direct.forEach((v) => {
    const item = document.createElement("div");
    item.className = "item";
    const ext = (v.url.split("?")[0].match(/\.([a-z0-9]+)$/i) || [, "mp4"])[1];
    item.innerHTML = `
      <div class="item-info">
        <span class="item-title">Fichier direct</span>
        <span class="item-meta">${formatSize(v.size)}</span>
      </div>
    `;
    const btn = document.createElement("button");
    btn.className = "download-btn";
    btn.textContent = "Télécharger";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const filename = `${sanitize(data.title || tab.title)}.${ext}`;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_DIRECT", url: v.url, filename }, (res) => {
        btn.textContent = res && res.error ? "Erreur" : "OK";
      });
    });
    item.appendChild(btn);
    listEl.appendChild(item);
  });

  data.hls.forEach((v) => {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div class="item-info">
        <span class="item-title">Stream HLS</span>
        <span class="item-meta">Chargement des qualités...</span>
      </div>
    `;
    listEl.appendChild(item);
    chrome.runtime.sendMessage({ type: "PARSE_HLS", url: v.url }, (result) => {
      renderHlsItem(item, v, result, tab, data);
    });
  });
}

function renderHlsItem(item, v, result, tab, data) {
  if (result.error) {
    item.innerHTML = `<div class="item-info"><span class="item-title">Stream HLS</span><span class="item-meta">Erreur: ${result.error}</span></div>`;
    return;
  }
  const variants = result.master ? result.variants : [{ url: v.url }];
  item.innerHTML = `<div class="item-info"><span class="item-title">Stream HLS</span></div>`;
  variants.forEach((variant) => {
    const row = document.createElement("div");
    row.className = "variant-row";
    const label = variant.resolution || (variant.bandwidth ? `${Math.round(variant.bandwidth / 1000)} kbps` : "Qualité unique");
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const btn = document.createElement("button");
    btn.className = "download-btn";
    btn.textContent = "Télécharger";
    btn.dataset.url = variant.url;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "...";
      const filename = `${sanitize(data.title || tab.title)}.ts`;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_HLS", url: variant.url, filename }, (res) => {
        btn.textContent = res && res.error ? "Erreur" : "OK";
      });
    });
    row.appendChild(labelEl);
    row.appendChild(btn);
    item.appendChild(row);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "HLS_PROGRESS") {
    const btn = document.querySelector(`.download-btn[data-url="${CSS.escape(message.url)}"]`);
    if (btn) btn.textContent = `${message.done}/${message.total}`;
  }
});

init();
