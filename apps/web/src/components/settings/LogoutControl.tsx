/**
 * 設定モーダル最下部の「ログアウト」導線 (2026-08-06、ユーザー要望)。
 *
 * CacheClearControl / ResyncControl (「脱出口」2つ) や AccountsSection (Google アカウントの
 * 連携管理) とは性質が違うので独立したセクションにした:
 *  - 脱出口2つはどちらも「困ったときに立て直す」操作で、連携アカウント・設定は一切消えない
 *    (説明文にもそう明記してある)。ログアウトは逆に**セッションを終了したうえで端末内の
 *    データを消す**ので、この2つの隣に並べると「同じ強さの操作」に見えてしまう。
 *  - AccountsSection は Google アカウント単位(複数連携可)の連携解除を扱うが、ログアウトは
 *    アプリのセッション(Cookie)単位の操作で、どの Google アカウントとも1対1に対応しない。
 * そのためモーダル最下部、脱出口2つよりさらに下に独立セクションとして置く ――
 * 「表示が古い→キャッシュ削除」「予定がおかしい→再同期」ときても直らない場合の
 * 最後の手段、という並びの意図を保つ。
 *
 * 破壊的操作なので既存の ConfirmActionControl のインライン2段階確認に揃える
 * (window.confirm は使わない)。ただし ConfirmActionControl の errorLabel は固定文字列の
 * prop なので、「端末データの削除に失敗」と「ログアウト要求に失敗」を出し分けるために
 * この階層で state を持ち、onConfirm の catch で先に更新してから再 throw する
 * (ConfirmActionControl 側の catch が状態を "error" にして再描画するのはそのあとなので、
 * 表示される頃には最新の errorLabel が渡っている)。
 *
 * 説明文は「消えるもの/消えないもの」を利用者が誤解しないよう明示する (2026-08-06 の
 * 仕様変更): 当初は DB ごと消す設計で確認文にもそう書いていたが、それだと
 * plannedBlocks/timeEntries (サーバーに対応が無いローカル専用のタイムブロック・作業タイマー
 * 記録、db/database.ts の LOGOUT_KEPT_STORES 参照) まで消えてしまい復元できなくなるため
 * ストア単位の削除に変更した。文言もこの実装に合わせ、「予定データは消えて再ログインで
 * 取り直せる」ことと「タイムブロック・作業タイマーの記録はこの端末に残る」ことの
 * 両方を明示する。
 */
import { useState } from "react";
import { LogoutError } from "../../sync/logout";
import { ConfirmActionControl } from "./ConfirmActionControl";

const DEFAULT_ERROR_LABEL = "ログアウトに失敗しました";

/** LogoutError.stage → 利用者向けの短い失敗理由。undefined は想定外のエラー用のフォールバック */
function errorLabelForStage(stage: LogoutError["stage"] | undefined): string {
  switch (stage) {
    case "local-data":
      // まだセッションは生きている(サーバーへは要求を送っていない)ので、その旨を伝える
      return "端末データの削除に失敗しました(ログアウトはしていません)";
    case "session":
      // 端末データは既に消えている。もう一度押すだけで良いことを伝える
      return "端末データは削除しましたが、ログアウト要求に失敗しました";
    default:
      return DEFAULT_ERROR_LABEL;
  }
}

export function LogoutControl({ onLogout }: { onLogout: () => Promise<void> }) {
  const [errorLabel, setErrorLabel] = useState(DEFAULT_ERROR_LABEL);

  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">ログアウト</h3>
      <p className="settings-modal-section-desc">
        {/* 「GitHub 連携情報」と書くと連携そのもの (サーバー側の github_connections) が
            切れると読めてしまうため、この端末から消えるのは取得済みの一覧だけだと分かる
            書き方にする。連携・作業実績はサーバー側にあり、ログアウトでは消えない。 */}
        {"ログアウトすると、この端末に保存されている予定・タスク・GitHub の一覧を削除した" +
          "うえで、ログイン状態を終了します。予定データは再ログインすれば Google から" +
          "取り直せます。GitHub の連携と作業実績はサーバー側にあるので、消えません。" +
          "タイムブロックと作業タイマーの記録はこの端末にしか無いデータのため、" +
          "ログアウトしても削除されずこの端末に残ります。"}
      </p>
      <ConfirmActionControl
        triggerLabel="ログアウト"
        question="ログアウトしますか？"
        confirmLabel="ログアウトする"
        errorLabel={errorLabel}
        logLabel="logout"
        onConfirm={() =>
          onLogout()
            .catch((err: unknown) => {
              setErrorLabel(errorLabelForStage(err instanceof LogoutError ? err.stage : undefined));
              throw err;
            })
            .then(() => {
              // CacheClearControl と同じ流儀: 画面ごと作り直す(古い db/state の参照を残さない)
              window.location.reload();
            })
        }
      />
    </section>
  );
}
