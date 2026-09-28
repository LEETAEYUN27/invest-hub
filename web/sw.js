// 네트워크 우선 : 온라인이면 항상 최신 빌드, 오프라인이면 마지막으로 받은 화면·데이터(암호문)
const C = "hub-v1";
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(["./", "index.html", "app.css", "app.js", "icon.svg"]))); });
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(u.pathname.endsWith("data.enc.json") ? "data.enc.json" : e.request, cp)); return r; })
    .catch(() => caches.match(u.pathname.endsWith("data.enc.json") ? "data.enc.json" : e.request)));
});
