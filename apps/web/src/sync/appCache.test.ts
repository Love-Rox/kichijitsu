import { afterEach, describe, expect, it } from "vite-plus/test";
import { clearAppCaches, isAppCacheKey } from "./appCache";

describe("isAppCacheKey", () => {
  it("sw.js が実際に作るキャッシュ名は対象", () => {
    expect(isAppCacheKey("kichijitsu-shell-v1")).toBe(true);
    expect(isAppCacheKey("kichijitsu-assets-v1")).toBe(true);
  });

  it("将来バージョンが上がっても接頭辞さえ合えば対象 (sw.js の activate と同じ判定)", () => {
    expect(isAppCacheKey("kichijitsu-assets-v9")).toBe(true);
    expect(isAppCacheKey("kichijitsu-")).toBe(true);
  });

  it("他サイト/他ライブラリのキャッシュは巻き込まない", () => {
    expect(isAppCacheKey("other-cache")).toBe(false);
    expect(isAppCacheKey("workbox-precache-v2")).toBe(false);
    expect(isAppCacheKey("")).toBe(false);
  });

  it("紛らわしい境界: ハイフンまで一致しないものは対象外", () => {
    // 接頭辞は "kichijitsu-" までを含む。名前が似ているだけの別キャッシュを消さないため。
    expect(isAppCacheKey("kichijitsu")).toBe(false);
    expect(isAppCacheKey("kichijitsu2-assets-v1")).toBe(false);
    expect(isAppCacheKey("my-kichijitsu-assets")).toBe(false);
    expect(isAppCacheKey("Kichijitsu-shell-v1")).toBe(false);
  });
});

/** caches の最小スタブ。delete は「存在すれば消して true」という本物の契約に合わせる */
function stubCacheStorage(initialKeys: string[]) {
  const store = new Set(initialKeys);
  const stub = {
    keys: () => Promise.resolve([...store]),
    delete: (key: string) => Promise.resolve(store.delete(key)),
  };
  (globalThis as { caches?: unknown }).caches = stub;
  return store;
}

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe("clearAppCaches", () => {
  it("kichijitsu- のキャッシュだけを消し、消したキー名を返す", async () => {
    const store = stubCacheStorage([
      "kichijitsu-shell-v1",
      "kichijitsu-assets-v1",
      "other-cache",
      "kichijitsu",
    ]);

    const deleted = await clearAppCaches();

    expect(deleted.toSorted()).toEqual(["kichijitsu-assets-v1", "kichijitsu-shell-v1"]);
    // 他所のキャッシュは残る (境界の実挙動)
    expect([...store].toSorted()).toEqual(["kichijitsu", "other-cache"]);
  });

  it("消すものが無ければ空配列", async () => {
    stubCacheStorage(["other-cache"]);
    expect(await clearAppCaches()).toEqual([]);
  });

  it("caches が無い環境 (未対応ブラウザ / 非セキュアコンテキスト) では例外を投げず空配列", async () => {
    delete (globalThis as { caches?: unknown }).caches;
    expect(await clearAppCaches()).toEqual([]);
  });
});
