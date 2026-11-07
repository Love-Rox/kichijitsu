/**
 * アプリの再読み込み(キャッシュを捨ててから、ページを読み直す)。
 *
 * このアプリは Service Worker(public/sw.js)が CSS/JS を cache-first で返すので、単純な
 * `location.reload()` だけでは、HTML だけが新しくなり、資産は古いままになることがある。
 * そこで、`kichijitsu-` で始まる Cache Storage を先に消してから読み直す。デスクトップ版の
 * トレイ「再読み込み」(apps/desktop/src-tauri/src/lib.rs の RELOAD_JS)と同じ手順。
 * キャッシュを消せない環境でも、読み直しだけは必ず行う。
 */
export async function reloadApp(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("kichijitsu-")).map((k) => caches.delete(k)));
    }
  } catch {
    // キャッシュが消せなくても、読み直す
  }
  location.reload();
}
