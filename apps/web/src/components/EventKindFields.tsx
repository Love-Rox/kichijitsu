import type { OutOfOfficeAutoDecline } from "@kichijitsu/shared";

/**
 * 新規予定の「種別」入力 (2026-11-06)。「予定」と「不在」を切り替え、不在のときだけ
 * 自動辞退と辞退メッセージを出す。クイック作成ポップオーバー (DayColumn) と
 * 詳細フォーム (EventEditForm の作成モード) の両方で同じ見た目・同じ文言にするため共有する。
 *
 * 不在は Google 側の制約で終日にできない。呼び出し側が onKindChange("outOfOffice") を
 * 受けたときに終日をやめる(このコンポーネントは状態を持たない)。
 */
export interface EventKindValue {
  kind: "default" | "outOfOffice";
  autoDecline: OutOfOfficeAutoDecline;
  declineMessage: string;
}

const DECLINE_LABELS: { value: OutOfOfficeAutoDecline; label: string }[] = [
  { value: "declineOnlyNewConflictingInvitations", label: "新しい招待だけ辞退する" },
  { value: "declineAllConflictingInvitations", label: "既存の予定も含めて辞退する" },
  { value: "declineNone", label: "辞退しない" },
];

export function EventKindFields({
  value,
  onChange,
}: {
  value: EventKindValue;
  onChange: (next: EventKindValue) => void;
}) {
  const isOoo = value.kind === "outOfOffice";
  return (
    <div className="event-kind">
      <div className="event-kind-tabs" role="group" aria-label="予定の種別">
        <button
          type="button"
          className="event-kind-tab"
          aria-pressed={!isOoo}
          onClick={() => onChange({ ...value, kind: "default" })}
        >
          予定
        </button>
        <button
          type="button"
          className="event-kind-tab"
          aria-pressed={isOoo}
          onClick={() => onChange({ ...value, kind: "outOfOffice" })}
        >
          不在
        </button>
      </div>
      {isOoo && (
        <>
          <label className="event-edit-field">
            <span className="event-edit-label">招待の自動辞退</span>
            <select
              className="event-edit-input"
              value={value.autoDecline}
              onChange={(e) =>
                onChange({ ...value, autoDecline: e.target.value as OutOfOfficeAutoDecline })
              }
            >
              {DECLINE_LABELS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {value.autoDecline !== "declineNone" && (
            <label className="event-edit-field">
              <span className="event-edit-label">辞退メッセージ(任意)</span>
              <input
                type="text"
                className="event-edit-input"
                value={value.declineMessage}
                onChange={(e) => onChange({ ...value, declineMessage: e.target.value })}
              />
            </label>
          )}
          <p className="event-kind-note">
            不在はメインのカレンダーにだけ作れます。終日にはできません。
          </p>
        </>
      )}
    </div>
  );
}
