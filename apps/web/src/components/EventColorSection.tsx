import { useState } from "react";
import { EVENT_COLORS, colorIdOf } from "../layout/eventColorChoices";
import type { RecurrenceScope } from "../sync/recurrenceScope";
import "./EventColorSection.css";

/**
 * 詳細カードの「色」欄: Google のイベント色 11 色と「カレンダーの色」(予定個別の色を外す)から選ぶ。
 * 押すと保存を依頼し、成功してから反映される(失敗したら理由をカード内に出す)。ゲストへのメールは出ない。
 * 繰り返しの予定は、「この予定のみ/すべての予定」を選べる(既定は、この予定のみ)。
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
  onSetColor: (
    colorId: string | null,
    calendarColor: string,
    scope: RecurrenceScope,
  ) => Promise<void>;
}) {
  // 繰り返しの予定の適用範囲。既定は影響の小さい「この回だけ」(Google カレンダーと同じ)
  const [scope, setScope] = useState<RecurrenceScope>("this");
  const current = colorIdOf(color, hasCustomColor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = (colorId: string | null) => {
    if (pending || colorId === current) return;
    setPending(true);
    setError(null);
    onSetColor(colorId, calendarColor, scope)
      .catch(() => setError("色を変えられませんでした。もう一度お試しください。"))
      .finally(() => setPending(false));
  };

  return (
    <div className="event-detail-colors" role="group" aria-label="予定の色">
      <div className="event-detail-colors-head">色</div>
      {isRecurring && (
        <div className="event-detail-colors-scope" role="group" aria-label="色を変える範囲">
          {(
            [
              ["this", "この予定のみ"],
              ["all", "すべての予定"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="event-detail-colors-scope-btn"
              aria-pressed={scope === value}
              disabled={pending}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
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
