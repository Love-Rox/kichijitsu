/**
 * 端末ごと syncToken (2026-07-21)。UserSyncDO の SQLite が実際に触る行の形は変わるが、
 * 「どのトークンを読むべきか」「どの行が古くなったか」の判定だけを純関数として切り出し、
 * DO 本体 (SqlStorage への依存があり単体テストしにくい) から分離してテスト可能にする。
 *
 * 設計の背景 (design flaw): 従来 sync_tokens はアカウント単位 DO の中で calendar_id を
 * キーに全端末共有だった。端末Aが同期するとトークンが進み、その差分は A の IndexedDB
 * にしか適用されないため、端末Bはその差分を永久に取りこぼしていた (各端末がローカル
 * レプリカを持つ設計なので、差分は端末ごとに配られなければならない)。
 * 修正: 同期トークンを (calendar_id, device_id) 単位の新テーブル sync_tokens_v2 に持つ。
 */

export interface SyncTokenRowLike {
  sync_token: string | null;
}

/**
 * 端末ごとの syncToken 読み出し判定。
 * - deviceId 無し (旧クライアントの in-flight リクエスト): レガシー共有テーブルの値を
 *   そのまま返す (従来通りの共有トークン動作)。
 * - deviceId あり、sync_tokens_v2 に行がある: その値をそのまま返す (null も含め尊重 —
 *   null は「この端末で 410 フォールバック済み、次回は全同期」を意味する)。
 * - deviceId あり、sync_tokens_v2 に行が無い: レガシー行があればそれを「seed」として
 *   返す。これにより、この端末の初回同期がいきなり全同期にならずに済む
 *   (Google の syncToken は複数クライアントで安全に fork できる — 使うたびに新しい
 *   nextSyncToken が返り、以後は端末ごとに独立して進む)。レガシー行も無ければ null
 *   (=全同期)。
 */
export function resolveSyncTokenRead(
  hasDeviceId: boolean,
  v2Row: SyncTokenRowLike | null,
  legacyRow: SyncTokenRowLike | null,
): string | null {
  if (!hasDeviceId) return legacyRow?.sync_token ?? null;
  if (v2Row) return v2Row.sync_token;
  return legacyRow?.sync_token ?? null;
}

/** sync_tokens_v2 の掃除しきい値 (60日)。この期間更新の無い端末の行は削除する。 */
export const V2_TOKEN_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** 60日以上更新の無い sync_tokens_v2 行かどうか (境界値テスト用に公開)。 */
export function isStaleV2Token(updatedAt: number, now: number): boolean {
  return now - updatedAt > V2_TOKEN_MAX_AGE_MS;
}
