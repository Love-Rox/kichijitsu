/**
 * 「Google の再認証が必要」なアカウントに対して**クライアントの自動同期を止めてよいか**の
 * 判定 (2026-08-07、本番実測: アカウント vo.parc... の refresh_token が失効し
 * accounts.reauth_required_at が立った状態で、サーバー側 alarm の自動リトライは
 * apps/sync/src/core/reauth.ts の shouldSkipAlarmRetry で止めてあったにもかかわらず、
 * クライアントの自動同期 (起動時 runSync・SSE hello/changed) が POST /api/sync を毎分
 * 叩き続け、40分で40回すべて invalid_grant で失敗していた ―― alarm より高い頻度になって
 * しまい、対策の意味が薄れていた)。
 *
 * # 「自動」と「明示的」を区別する理由
 * サーバー側 shouldSkipAlarmRetry と同じ非対称をクライアント側にも作る:
 *  - **自動 (auto)**: 起動時の runSync、SSE hello/changed 起因の同期、カレンダー選択
 *    トグルなど、利用者が「いま同期しろ」と意図していない経路。reauthRequired なアカウントに
 *    対しては黙ってスキップしてよい ―― どうせ invalid_grant になると分かっている呼び出しを
 *    繰り返さない。
 *  - **明示的 (manual)**: 手動「同期」ボタン・設定モーダルの「再同期」など、利用者が
 *    明示的に押した経路。**これはスキップしない** ―― reauthRequired の記録
 *    (/api/me の AccountDTO.reauthRequired) が何らかの理由で誤っていた場合に、利用者が
 *    自分で「試す」ことすらできず永久に復帰できなくなるのを避けるため
 *    (apps/sync/src/core/reauth.ts の shouldSkipAlarmRetry コメント ―― サーバー側も
 *    alarm 以外の RPC (手動同期・再連携直後の初回同期) はこの判定を経由しない、というのと
 *    同じ理由)。
 *
 * # trigger に既定値を持たせない理由
 * hooks/useCalendarSync.ts 側の呼び出し関数 (syncCalendar/syncTaskList/runSync) は trigger を
 * **省略不可**にしてある。「省略時は auto 扱い」のような暗黙の既定値を持たせると、将来
 * 新しい呼び出し経路が増えたときに、trigger を書き忘れただけで気づかぬうちに自動スキップの
 * 対象になってしまう (= 新しい「明示的な」経路のつもりが黙って何もしない、という一番気づき
 * にくい壊れ方をする)。呼び出し側に判断を強制することで、新しい経路を足す人が「これは
 * auto か manual か」を必ず一度考えることになる。
 */

/** 同期の起点。呼び出し元がどちらかを明示的に選ぶ (このファイル冒頭のコメント参照)。 */
export type SyncTrigger = "auto" | "manual";

/**
 * 自動経路 (trigger === "auto") の同期を、再認証待ち (reauthRequired) なアカウントに対して
 * スキップすべきか判定する純関数。「自動経路 かつ 再認証待ち」のときだけ true。
 * manual はどんな reauthRequired 状態でも常に false (= 止めない)。
 */
export function shouldSkipAutoSyncForReauth(trigger: SyncTrigger, reauthRequired: boolean): boolean {
  return trigger === "auto" && reauthRequired;
}
