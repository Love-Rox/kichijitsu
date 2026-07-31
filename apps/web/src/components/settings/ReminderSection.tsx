/**
 * 設定モーダルの「予定のリマインダー通知」セクション (デスクトップ版のみ、2026-07-30) を
 * 担当するファイル。通知タイミングの選択と「テスト通知を送る」は、
 * 「通知が本当に届くか」を利用者自身が確かめるという1つの目的でつながっているので同居させる。
 */
import { useState } from "react";
import { notifyNatively } from "../../sync/desktopNotify";
import {
  getReminderMode,
  MAX_HONORED_LEAD_MINUTES,
  REMINDER_LEAD_PRESETS,
  serializeReminderMode,
  setReminderMode,
  type ReminderMode,
} from "../../sync/reminderSchedule";

/**
 * 「何分前に通知するか」の選択肢。値の正は sync/reminderSchedule.ts の ReminderMode /
 * REMINDER_LEAD_PRESETS で、ここは表示ラベルだけを足している。
 *
 * 先頭が既定の「Google の設定に従う」。以下は「Google 側の設定を無視して一律◯分前」で、
 * 2026-07-30 時点の挙動をそのまま選べるように残してある(この設定で明示的に分数を
 * 選んでいた利用者は、その選択のまま引き継がれる ―― parseReminderMode 参照)。
 */
const REMINDER_MODE_OPTIONS: { mode: ReminderMode; label: string }[] = [
  { mode: { kind: "google" }, label: "Google の設定に従う" },
  { mode: { kind: "off" }, label: "通知しない" },
  ...REMINDER_LEAD_PRESETS.map((minutes) => ({
    mode: { kind: "fixed", minutes } as ReminderMode,
    label: minutes >= 60 ? `一律 ${minutes / 60} 時間前` : `一律 ${minutes} 分前`,
  })),
];

/**
 * 予定のリマインダー通知の設定 (デスクトップ版のみ、2026-07-30)。
 *
 * 値の正は localStorage で、ここの useState は「いま何が選ばれているか」を描くための
 * ローカルな写し (ThemeControl / GhPathOverrideControl と同じ流儀)。判定側
 * (hooks/useEventReminders.ts) は 30 秒ごとに localStorage を読み直すので、
 * App.tsx に state を持ち上げる必要は無い。
 *
 * 自由入力の分数ではなくプリセットの <select> にしているのは、
 * (1) このアプリに `type="number"` の入力が1つも無い (HourHeightControl もプリセット) 、
 * (2) 極端に短い分数は判定 tick の間隔と噛み合わない
 *     (sync/reminderSchedule.ts の REMINDER_LEAD_PRESETS のコメント参照) の2点から。
 *
 * ## 「テスト通知を送る」がなぜ必要か
 * macOS の通知許可が拒否されていても、**プログラムからはそれを知る術が無い** ――
 * tauri-plugin-notification の desktop 実装は送出を別タスクへ投げて結果を捨てており、
 * `permission_state()` も desktop では常に Granted のハードコード
 * (apps/desktop/src-tauri/src/lib.rs の notify コマンドのコメント参照)。
 * 「許可されています」と嘘をつくわけにもいかず、黙って何も起きないのが最悪なので、
 * **利用者自身がその場で確かめられるボタン**と、出なかったときに次に何をすればよいか
 * (OS の設定のどこを見るか) を置く形にした。
 */
export function ReminderSection() {
  const [mode, setMode] = useState<ReminderMode>(() => getReminderMode());
  const [tested, setTested] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const sendTest = () => {
    setTested(false);
    setTestError(null);
    void notifyNatively("kichijitsu", "テスト通知です。これが見えていれば通知は届きます。").then(
      (sent) => {
        if (sent) setTested(true);
        else setTestError("通知の送出に失敗しました。アプリを再起動して試してください。");
      },
    );
  };

  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title" id="settings-reminder-title">
        予定のリマインダー通知
      </h3>
      <p className="settings-modal-section-desc">
        予定が始まる前に、macOS の通知でお知らせします。既定では
        <strong>Google カレンダー側で予定ごとに設定した通知に従います</strong>
        ―― Google 側で「30 分前」にしてある予定は 30 分前に、通知を設定していない予定は通知しません。時刻のない終日の予定は通知しません。
      </p>
      <p className="settings-modal-section-desc">
        通知が届くのは kichijitsu が起動している間だけです(ウィンドウを閉じてトレイに隠している間は届きます。トレイメニューの「終了」でアプリを終わらせている間は届きません)。
      </p>
      <div className="settings-modal-reminder-row">
        <label className="settings-modal-reminder-label" htmlFor="settings-reminder-lead">
          通知するタイミング
        </label>
        <select
          id="settings-reminder-lead"
          className="settings-modal-reminder-select"
          value={serializeReminderMode(mode)}
          onChange={(e) => {
            const next =
              REMINDER_MODE_OPTIONS.find((o) => serializeReminderMode(o.mode) === e.target.value)
                ?.mode ?? mode;
            setReminderMode(next);
            setMode(next);
          }}
        >
          {REMINDER_MODE_OPTIONS.map((option) => (
            <option key={serializeReminderMode(option.mode)} value={serializeReminderMode(option.mode)}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {/*
       * 選んだ結果どうなるかを、その場で1文だけ添える。「Google の設定に従う」は
       * 説明すべきことが多い(複数設定・カレンダー既定・上限)ので、そこだけ厚くする。
       */}
      <p className="settings-modal-section-desc">
        {mode.kind === "google" ? (
          <>
            予定に通知が複数(「1 時間前」と「10 分前」など)設定されていれば、そのすべてでお知らせします。「デフォルトの通知を使用」の予定はカレンダーごとの既定に従います。
            <strong>メールの通知は対象外</strong>(Google
            が自分でメールを送るため)、
            <strong>{MAX_HONORED_LEAD_MINUTES / 60} 時間より前の通知も対象外</strong>です。
          </>
        ) : mode.kind === "off" ? (
          <>予定側の設定に関わらず、通知は出しません。</>
        ) : (
          <>
            <strong>Google 側の設定は使いません。</strong>ここで選んだ分数を、すべての予定に一律で適用します。
          </>
        )}
      </p>
      <div className="settings-modal-reminder-row">
        <button type="button" className="settings-modal-text-btn" onClick={sendTest}>
          テスト通知を送る
        </button>
      </div>
      {/* 押下で内容が入れ替わる場所なので、読み上げにも変化が伝わるようにする */}
      <p className="settings-modal-reminder-hint" aria-live="polite">
        {testError ? (
          <span className="settings-modal-error">{testError}</span>
        ) : tested ? (
          "送りました。通知が出なければ、macOS の「システム設定 → 通知」で kichijitsu の通知が許可されているか確認してください。"
        ) : (
          "通知が来ているか不安なときは、テスト通知で確かめられます。"
        )}
      </p>
    </section>
  );
}
