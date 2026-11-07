import { useState } from "react";
import { EVENT_COLORS, colorIdOf } from "../layout/eventColorChoices";
import "./EventColorSection.css";

/**
 * 詳細カードの「色」欄: Google のイベント色 11 色と「カレンダーの色」(予定個別の色を外す)から選ぶ。
 * 押すと保存を依頼し、成功してから反映される(失敗したら理由をカード内に出す)。ゲストへのメールは出ない。
 * 繰り返しの予定は、その回だけの色になる。
 */
export function EventColorSection({
  color,
  hasCustomColor,
  calendarColor,
  isRecurring,
  onSetColor,
}: {
  /** 今の表示色(hex)と、それが予定個別の色か */
  color: string;
  hasCustomColor: boolean | undefined;
  /** 予定が属するカレンダーの色(個別色を外したときの表示色)。分からなければ今の色 */
  calendarColor: string;
  isRecurring: boolean;
  onSetColor: (colorId: string | null, calendarColor: string) => Promise<void>;
}) {
  const current = colorIdOf(color, hasCustomColor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (colorId: string | null) => {
    if (pending || colorId === current) return;
    setPending(true);
    setError(null);
    onSetColor(colorId, calendarColor)
      .catch(() => setError("色を変えられませんでした。もう一度お試しください。"))
      .finally(() => setPending(false));
  };

  return (
    <div className="event-detail-colors" role="group" aria-label="予定の色">
      <div className="event-detail-colors-head">
        色{isRecurring ? "(この回だけ)" : ""}
      </div>
      <div className="event-detail-colors-row">
        <button
          type="button"
          className={`event-color-swatch event-color-swatch--calendar${current === null ? " is-selected" : ""}`}
          style={{ background: calendarColor }}
          disabled={pending}
          onClick={() => choose(null)}
          aria-label="カレンダーの色"
          aria-pressed={current === null}
          title="カレンダーの色"
        />
        {EVENT_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`event-color-swatch${current === c.id ? " is-selected" : ""}`}
            style={{ background: c.hex }}
            disabled={pending}
            onClick={() => choose(c.id)}
            aria-label={c.name}
            aria-pressed={current === c.id}
            title={c.name}
          />
        ))}
      </div>
      {error && (
        <div className="event-detail-colors-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
