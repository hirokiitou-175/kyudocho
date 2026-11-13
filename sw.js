// 弓道帳 サービスワーカー
// アプリ本体（画面・プログラム）を端末に控えておき、電波のない場所でも開けるようにする。
// 記録データの通信（Firestore・ログイン）は対象外で、そちらは Firestore 自身の
// オフライン機能（端末への保存と自動送信）に任せる。
const VERSION = "20251105-33";
const SHELL_CACHE = `kyudocho-shell-${VERSION}`;
const SDK_CACHE = "kyudocho-sdk-v1";
const INDEX_URL = new URL("./index.html", self.registration.scope).href;
const SHELL_FILES = [
  "./",
  "./index.html",
  `./styles.css?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./firebase.js?v=${VERSION}`,
  `./firebase-config.js?v=${VERSION}`,
  "./manifest.webmanifest",
  "./icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith("kyudocho-shell-") && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 記録データ・ログインの通信には触らない
  if (url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("firebaseio.com")) return;

  // Firebase のプログラム部品は版が決まったURLなので、端末の控えを優先する
  if (url.hostname === "www.gstatic.com") {
    event.respondWith(
      caches.open(SDK_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // ページを開くときは、まず通信で最新を取りに行き、つながらなければ控えを使う
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(INDEX_URL, copy));
          }
          return res;
        })
        .catch(() => caches.match(INDEX_URL))
    );
    return;
  }

  // それ以外（版番号つきの部品など）は、端末の控えを優先する
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
