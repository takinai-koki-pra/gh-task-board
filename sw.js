// アプリシェルをキャッシュする Service Worker。GitHub API はキャッシュしない。
const VERSION = "v2";
const CACHE = `ghtb-${VERSION}`;
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./api.js", "./manifest.webmanifest", "./icons/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.hostname === "api.github.com") return; // 常にネットワーク
  if (url.origin !== location.origin) return; // フォント等はブラウザに任せる
  if (url.pathname.includes("/gh/") || url.pathname.endsWith("/__local")) return; // ローカルプロキシ経由の API
  // stale-while-revalidate: キャッシュを即返し、裏で更新する
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
