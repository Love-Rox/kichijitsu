/**
 * ログアウト時に端末の localStorage を掃除する層 (2026-08-06)。IndexedDB のストア削除
 * (db/database.ts の clearLogoutTargetStores) と対になる ―― こちらは `kichijitsu:` 名前空間の
 * localStorage キー (hourHeight・view・reminderLead 等、現在12個) を担当する。
 *
 * **キーは明示列挙しない**: 消す対象を `["kichijitsu:view", "kichijitsu:hourHeight", ...]` の
 * ように書き出すと、この名前空間に新しいキーが増えるたびにここへ追記し忘れる余地が生まれる。
 * ログアウトは「端末のデータを消す」ことが利用者への約束なので、消し漏れは
 * 「消したはずのデータが残っている」という一番気付きにくく、かつ一番まずい壊れ方をする。
 * そのため接頭辞 `kichijitsu:` で走査し、例外 (テーマ設定) だけを明示的に除外する設計にした。
 */
import { THEME_STORAGE_KEY } from "./themePref";

const KICHIJITSU_STORAGE_PREFIX = "kichijitsu:";

/**
 * ログアウト時に消してよい localStorage キーかどうか。
 *
 * 唯一の例外がテーマ設定 (kichijitsu:theme) ―― これは Google アカウントに紐づく個人データ
 * ではなく単なる配色の好みで、残しても「セッションと端末内のデータを消す」という
 * ログアウトの約束(仕様)を破らない。逆に消してしまうと、再ログイン後に配色が
 * 勝手に OS 連動へ戻るという利用者にとって不利益しかない副作用が起きるだけなので、
 * 明示的に除外する。
 */
export function isLogoutClearableStorageKey(key: string): boolean {
  return key.startsWith(KICHIJITSU_STORAGE_PREFIX) && key !== THEME_STORAGE_KEY;
}

/**
 * 列挙可能な Storage の最小形。layout/localStore.ts の StorageLike は読み書きだけを
 * 抽象化しており列挙手段 (length/key) を持たないため、ここだけ別の最小インターフェースを
 * 定義する(呼び出し元はブラウザでは window.localStorage をそのまま渡せる ―― Web Storage API
 * が length/key/removeItem を実装しているため)。
 */
export interface EnumerableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/**
 * `kichijitsu:` 名前空間の localStorage キーを(テーマ設定を除いて)すべて削除し、
 * 実際に消したキー名を返す。
 *
 * 先に対象キーを全部集めてから削除する2段構えにしているのは、Storage を走査しながら
 * 同時に removeItem すると添字がずれて一部のキーを読み飛ばしうるため(仕様上 Storage の
 * key(index) の順序保証は緩く、削除中の同時変更に対して安全とは言えない)。
 */
export function clearKichijitsuLocalStorage(storage: EnumerableStorage): string[] {
  const targets: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && isLogoutClearableStorageKey(key)) targets.push(key);
  }
  for (const key of targets) storage.removeItem(key);
  return targets;
}
