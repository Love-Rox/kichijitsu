/**
 * PWA / ブラウザのキャッシュ削除 (ユーザー要望、2026-07-26)。
 *
 * public/sw.js は静的アセット (ハッシュ付き js/css・アイコン等) を
 * cache-first + stale-while-revalidate で持つため、再デプロイ直後に「古いアセットが
 * 1回は使われる」ことがある。デスクトップ (Tauri) 版には既に同等の仕組みがある
 * (apps/desktop/src-tauri/src/lib.rs の RELOAD_JS ―― `kichijitsu-` 始まりの
 * Cache Storage を消してからリロードする) が、PWA / ブラウザには手動の脱出口が
 * 無かった。ここはその web 側の実装で、RELOAD_JS と同じ考え方に揃えてある。
 *
 * 消すのは Cache Storage だけ。IndexedDB (カレンダーデータ本体) には触れない ――
 * 消すと全同期のやり直しになるため、「表示用キャッシュの破棄」と
 * 「ローカルデータの初期化」は別物として扱う。
 *
 * Service Worker の登録自体も解除しない (unregister しない)。登録が残っていれば
 * リロード直後から SW が最新アセットを取り直してキャッシュを埋め直せるが、
 * unregister すると再登録が完了するまでオフラインで開けない窓ができてしまう
 * ――「オフライン利用を壊さない」ことを優先した判断。sw.js 自体の更新は
 * ナビゲーション時のブラウザ標準の更新チェックに任せる。
 */

/**
 * アプリが所有する Cache Storage キーの接頭辞。public/sw.js の
 * SHELL_CACHE ("kichijitsu-shell-v1") / ASSET_CACHE ("kichijitsu-assets-v1")、
 * および sw.js の activate ハンドラが使う古キャッシュ判定と同じ値。
 */
const APP_CACHE_PREFIX = "kichijitsu-";

/**
 * Cache Storage のキーが「このアプリのもの」か。
 *
 * 削除対象の境界そのもの ―― 同一オリジンの Cache Storage は他のスクリプトや
 * 将来の別機能とも共有されうるため、接頭辞に一致しないキーは絶対に巻き込まない。
 * 接頭辞 (ハイフンまで) が完全に一致することを要求するので、"kichijitsu" 単体や
 * "kichijitsu2-..." のような紛らわしいキーは対象外になる。
 */
export function isAppCacheKey(key: string): boolean {
  return key.startsWith(APP_CACHE_PREFIX);
}

/**
 * `kichijitsu-` 始まりの Cache Storage をすべて削除し、実際に消えたキー名を返す。
 *
 * Cache Storage 非対応 / 非セキュアコンテキスト (caches が無い環境) では例外を
 * 投げず空配列を返す ―― 呼び出し側 (設定モーダル) は削除の可否に関わらず
 * リロードまで進めたいので、ここで失敗させない。
 */
export async function clearAppCaches(): Promise<string[]> {
  const cacheStorage: CacheStorage | undefined = globalThis.caches;
  if (!cacheStorage) return [];

  const keys = await cacheStorage.keys();
  const deleted = await Promise.all(
    keys.filter(isAppCacheKey).map(async (key) => ({
      key,
      // delete は「そんなキャッシュは無かった」場合に false を返す。
      // 競合 (SW の activate が同時に消した等) で false になった分は報告しない。
      ok: await cacheStorage.delete(key),
    })),
  );
  return deleted.filter((entry) => entry.ok).map((entry) => entry.key);
}
