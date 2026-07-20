// kichijitsu Service Worker (手書き — vite-plugin-pwa は使用しない)
//
// vite-plugin-pwa 等の自動生成 SW ではなく手書きにしているのは、
// /api・/auth (特に /api/events の SSE ストリーム) を確実にインターセプトせず
// ブラウザのデフォルト処理へ素通しさせる制御性を担保するため。
// 生成ワークフローに任せると precache 対象の判定やランタイムキャッシュ戦略が
// ブラックボックス化し、SSE を誤ってバッファ/キャッシュするリスクがある。

const SHELL_CACHE = "kichijitsu-shell-v1";
const ASSET_CACHE = "kichijitsu-assets-v1";
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("kichijitsu-") && !CURRENT_CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // /api, /auth (SSE を含む) は絶対にインターセプトしない。ブラウザのデフォルト
  // 処理に完全に委ねる (respondWith を呼ばない = ここで即 return)。
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth")) {
    return;
  }

  // GET 以外は素通し。
  if (request.method !== "GET") {
    return;
  }

  // クロスオリジンは素通し。
  if (url.origin !== self.location.origin) {
    return;
  }

  // ナビゲーションリクエスト: network-first。SPA なので全ルート同一シェル ("/")
  // をオフラインフォールバックとして使う。
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          void cache.put("/", response.clone());
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match("/");
          if (cached) return cached;
          throw new Error("offline and no cached shell available");
        }
      })(),
    );
    return;
  }

  // それ以外の同一オリジン GET (ハッシュ付き js/css・アイコン・favicon 等の
  // 静的アセット): cache-first + stale-while-revalidate。
  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);

      const revalidate = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) {
        // 裏で更新しつつ、キャッシュを即返す。
        event.waitUntil(revalidate);
        return cached;
      }

      const response = await revalidate;
      if (response) return response;
      throw new Error("asset unavailable offline");
    })(),
  );
});
