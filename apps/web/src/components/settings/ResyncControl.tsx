/**
 * 設定モーダル下部の脱出口その2「予定を再同期」を担当するファイル。
 * 姉妹の脱出口であるキャッシュ削除 (CacheClearControl.tsx) と対になっている。
 */
import { ConfirmActionControl } from "./ConfirmActionControl";

/**
 * 「再同期」導線 (ユーザー要望、2026-07-29)。キャッシュ削除の隣に置く姉妹の脱出口で、
 * 住み分けは「表示が古い → キャッシュ削除 / 予定の中身がおかしい → 再同期」。
 *
 * 効く理由: アプリ外 (Google カレンダー本体や他の端末) で消された予定の削除通知を一度でも
 * 取りこぼすと、Google の syncToken は先へ進んでしまい同じ通知は二度と来ないため、増分同期
 * (ツールバーの「同期」) では残骸を掃除できない。全同期の応答だけが
 * applyFullSyncAtomic (sync/applySync.ts) によるローカル複製の総入れ替えを起こす。
 *
 * 破棄と再取得を分けず1操作にしてあるのは、押した後にもう一度「同期」を押させないため
 * (hooks/useCalendarSync.ts の runFullResync が全同期まで走り切る)。
 */
export function ResyncControl({ onResync }: { onResync: () => Promise<void> }) {
  return (
    <div className="settings-modal-cache">
      <p className="settings-modal-section-desc">
        {"予定の中身がおかしいときに使います。表示中のカレンダーの予定を Google から全件取り直すため、" +
          "通信量と時間がかかります。作業実績・連携アカウント・設定は消えません。"}
      </p>
      <ConfirmActionControl
        triggerLabel="予定を再同期"
        question="予定を全件取り直しますか？"
        confirmLabel="再同期する"
        errorLabel="再同期失敗"
        successLabel="再同期しました"
        logLabel="full resync"
        onConfirm={onResync}
      />
    </div>
  );
}
