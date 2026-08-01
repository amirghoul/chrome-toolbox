function classify(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return { url, kind: "hls" };
  return { url, kind: "direct" };
}

function collectVideos() {
  const found = [];
  document.querySelectorAll("video").forEach((video) => {
    const srcs = new Set();
    if (video.currentSrc) srcs.add(video.currentSrc);
    if (video.src) srcs.add(video.src);
    video.querySelectorAll("source").forEach((s) => {
      if (s.src) srcs.add(s.src);
    });
    srcs.forEach((src) => {
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      found.push(classify(src));
    });
  });
  if (found.length) {
    chrome.runtime.sendMessage({ type: "FOUND_VIDEOS", videos: found, title: document.title }).catch(() => {});
  }
}

collectVideos();
new MutationObserver(() => collectVideos()).observe(document.body, { childList: true, subtree: true });
