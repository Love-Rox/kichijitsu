/**
 * 「Google の再認証が必要」状態にまつわる純粋な判定ロジック (2026-08-06)。
 * durable-object/user-sync-do.ts から呼ばれる薄い判定を、DO/D1 から切り離してテストできる
 * ようにここへ切り出す (toolbarMenuItems.ts と同じ考え方 ―― ランタイム依存の無い .ts に
 * 判定を寄せて固定する)。
 */

/**
 * alarm (ポーリングフォールバック、durable-object/user-sync-do.ts の alarm メソッド) が
 * このアカウントへの自動リトライを**止めてよいか**を判定する。
 *
 * accounts.reauth_required_at (nullable) が非 null = 恒久的な失敗
 * (google/oauth.ts の isPermanentRefreshFailure) を記録済み ―― 利用者が再認証しない限り
 * 絶対に回復しないと分かっているので、alarm はこれ以上叩かない
 * (本番障害: 2日間で246回、回復しないと分かっている更新を叩き続けていた)。
 *
 * **これは alarm 経由の自動リトライだけを止める判定であり、他の RPC (手動同期・
 * カレンダー一覧取得・再連携直後の初回同期など) には使わない** ―― それらは
 * UserSyncDO.getOrRefreshAccessToken を直接呼び、この判定を経由しない。理由は
 * 「記録が誤っていた場合に永久に復帰できなくなるのを避ける」ため: 利用者が明示的に
 * 操作した経路は、記録の正誤に関わらず常に Google へ実際に試しに行けなければならない。
 */
export function shouldSkipAlarmRetry(reauthRequiredAt: number | null): boolean {
  return reauthRequiredAt !== null;
}
