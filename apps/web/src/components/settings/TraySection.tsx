/**
 * 設定モーダルの「メニューバーに次の予定を出す」(デスクトップ版のみ、2026-11-07)。
 * 値の正は localStorage で、判定側(hooks/useTrayNextEvent.ts)が 30 秒ごとに読み直す。
 */
import { useEffect, useState } from "react";
import {
  getAutostart,
  getTrayNextEventEnabled,
  setAutostart,
  setTrayNextEventEnabled,
} from "../../sync/trayNextEvent";

export function TraySection() {
  const [enabled, setEnabled] = useState(() => getTrayNextEventEnabled());
  // ログイン時の自動起動(macOS)。値の正は OS 側(LaunchAgent のファイル)なので、開いたときに読む
  const [autostart, setAutostartState] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getAutostart().then((v) => !cancelled && setAutostartState(v));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">メニューバーに次の予定を出す</h3>
      <p className="settings-modal-section-desc">
        メニューバーのアイコンの横に、次の予定の時刻とタイトルを出します(1 時間以内なら「あと◯分」)。不在・勤務場所・辞退した予定は出しません。
      </p>
      <label className="event-edit-checkbox-field">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setTrayNextEventEnabled(e.target.checked);
            setEnabled(e.target.checked);
          }}
        />
        次の予定を出す
      </label>
      <p className="settings-modal-section-desc">
        トレイのメニュー(右クリック)には、次の会議に参加する項目と、今日のこれからの予定が並びます。
        ショートカット: <strong>Cmd+Option+J</strong> で次の会議に参加、<strong>Cmd+Option+N</strong> で予定を作る。
      </p>
      <label className="event-edit-checkbox-field">
        <input
          type="checkbox"
          checked={autostart}
          onChange={(e) => {
            const next = e.target.checked;
            setAutostartError(null);
            void setAutostart(next).then((ok) => {
              if (ok) setAutostartState(next);
              else setAutostartError("自動起動の設定を変えられませんでした(macOS のみ対応です)。");
            });
          }}
        />
        ログイン時に自動で起動する
      </label>
      {autostartError && (
        <p className="settings-modal-section-desc" role="alert">
          {autostartError}
        </p>
      )}
    </section>
  );
}
