/**
 * 設定モーダルの「メニューバーに次の予定を出す」(デスクトップ版のみ、2026-11-07)。
 * 値の正は localStorage で、判定側(hooks/useTrayNextEvent.ts)が 30 秒ごとに読み直す。
 */
import { useState } from "react";
import { getTrayNextEventEnabled, setTrayNextEventEnabled } from "../../sync/trayNextEvent";

export function TraySection() {
  const [enabled, setEnabled] = useState(() => getTrayNextEventEnabled());
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
    </section>
  );
}
