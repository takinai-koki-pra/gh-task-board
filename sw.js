// アプリシェルをキャッシュする Service Worker。GitHub API と AI はキャッシュしない。
const VERSION = "v4";
const CACHE = `ghtb-${VERSION}`;
const ICONS = [
  "tray", "sun", "hourglass", "sparkle", "moon", "kanban", "magnifying-glass", "gear", "circle", "check-circle",
  "slack-logo", "clipboard-text", "envelope-simple", "calendar-blank", "check-square", "chat-circle",
  "arrow-counter-clockwise", "arrow-clockwise", "plus", "x", "arrow-square-out", "user", "flag-banner",
  "folder-simple", "hash", "warning-circle", "play-circle", "paper-plane-tilt", "command", "stack",
  "circle-half", "list-plus", "robot", "caret-right",
].map((n) => `./icons/phosphor/${n}.svg`);
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./api.js", "./ai.js", "./model.js", "./ui.js", "./panel.js",
  "./palette.js", "./undo.js", "./intake.js", "./views/inbox.js", "./views/list.js", "./views/board.js",
  "./manifest.webmanifest", "./icons/icon.svg", ...ICONS,
];

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
  if (url.origin !== location.origin) return; // GitHub・フォント等はブラウザに任せる
  if (/\/(gh|ai)\//.test(url.pathname) || url.pathname.endsWith("/__config") || url.pathname.endsWith("/ai-spec.json")) return;
  // stale-while-revalidate: キャッシュを即返し、裏で更新する
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request)
        .then((res) => { if (res.ok && !res.redirected) cache.put(e.request, res.clone()); return res; }) // Access のログイン画面は保存しない
        .catch(() => cached);
      return cached || network;
    })
  );
});
