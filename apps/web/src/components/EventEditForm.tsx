import { useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  dateValueToExclusiveEndMs,
  dateValueToMs,
  datetimeLocalValueToMs,
  msExclusiveToDateValue,
  msToDateValue,
  msToDatetimeLocalValue,
  validateEventEditDraft,
  type EventEditDraft,
} from "../sync/eventEdit";

export interface EventEditFormProps {
  initialDraft: EventEditDraft;
  timeZone: string;
  /**
   * 終日トグルを出すか。繰り返し予定 (シリーズ由来、seriesId !== null) の1回分は
   * InstanceOverride が isAllDay の概念を持たない (v1 の終日繰り返し自体が未対応) ため、
   * 呼び出し側 (EventBlock/AllDayBar) が occurrence.seriesId === null のときだけ true を渡す。
   */
  canToggleAllDay: boolean;
  /** 保存ボタン。成功で resolve、失敗で reject(このコンポーネントがエラー表示してフォームを開いたままにする) */
  onSave: (draft: EventEditDraft) => Promise<void>;
  onCancel: () => void;
}

/**
 * 予定編集フォーム(フェーズ2、2026-07-22)。詳細ポップオーバー (EventBlock.tsx の
 * EventDetailCard) の編集モードとして描画される。時刻は datetime-local / 終日は date
 * 入力による精密入力(ドラッグ操作は使わない、要件どおり)。保存は非同期
 * (App.tsx の handleEditSave が POST /api/event/patch を待ってからローカルへ反映する
 * 「保存ボタン方式」)なので、このコンポーネント自身は楽観的更新を行わず、
 * 保存中・失敗を自前の state で表示する。
 */
export function EventEditForm({
  initialDraft,
  timeZone,
  canToggleAllDay,
  onSave,
  onCancel,
}: EventEditFormProps) {
  const [draft, setDraft] = useState<EventEditDraft>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const validationError = validateEventEditDraft(draft);

  function handleToggleAllDay(nextIsAllDay: boolean) {
    setDraft((prev) => {
      if (nextIsAllDay === prev.isAllDay) return prev;
      if (nextIsAllDay) {
        // 時刻 → 終日: 開始時刻の属する日を開始日、同じ日を終了日(単日)にする
        const dateValue = msToDateValue(prev.startMs, timeZone);
        return {
          ...prev,
          isAllDay: true,
          startMs: dateValueToMs(dateValue, timeZone),
          endMs: dateValueToExclusiveEndMs(dateValue, timeZone),
        };
      }
      // 終日 → 時刻: 開始日の 9:00〜10:00 をデフォルトにする(自然な初期値、ユーザーがすぐ調整できる)
      const dateValue = msToDateValue(prev.startMs, timeZone);
      const startMs = datetimeLocalValueToMs(`${dateValue}T09:00`, timeZone);
      return { ...prev, isAllDay: false, startMs, endMs: startMs + 60 * 60_000 };
    });
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (validationError || submitting) return;
    setSubmitting(true);
    setSaveError(null);
    onSave(draft)
      .catch((err) => {
        console.error("kichijitsu: event edit save failed", err);
        setSaveError("保存できませんでした。もう一度お試しください");
      })
      .finally(() => setSubmitting(false));
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <form className="event-edit-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
      <label className="event-edit-field">
        <span className="event-edit-label">タイトル</span>
        <input
          type="text"
          className="event-edit-input"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 編集モードに入った直後、そのままタイトルを打ち始められるように
          autoFocus
        />
      </label>

      <label className="event-edit-field">
        <span className="event-edit-label">場所</span>
        <input
          type="text"
          className="event-edit-input"
          value={draft.location}
          onChange={(e) => setDraft({ ...draft, location: e.target.value })}
        />
      </label>

      <label className="event-edit-field">
        <span className="event-edit-label">説明</span>
        <textarea
          className="event-edit-textarea"
          rows={3}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </label>

      {canToggleAllDay && (
        <label className="event-edit-checkbox-field">
          <input
            type="checkbox"
            checked={draft.isAllDay}
            onChange={(e) => handleToggleAllDay(e.target.checked)}
          />
          終日
        </label>
      )}

      {draft.isAllDay ? (
        <div className="event-edit-datetime-row">
          <label className="event-edit-field">
            <span className="event-edit-label">開始日</span>
            <input
              type="date"
              className="event-edit-input"
              value={msToDateValue(draft.startMs, timeZone)}
              onChange={(e) =>
                setDraft({ ...draft, startMs: dateValueToMs(e.target.value, timeZone) })
              }
            />
          </label>
          <label className="event-edit-field">
            <span className="event-edit-label">終了日</span>
            <input
              type="date"
              className="event-edit-input"
              value={msExclusiveToDateValue(draft.endMs, timeZone)}
              onChange={(e) =>
                setDraft({ ...draft, endMs: dateValueToExclusiveEndMs(e.target.value, timeZone) })
              }
            />
          </label>
        </div>
      ) : (
        <div className="event-edit-datetime-row">
          <label className="event-edit-field">
            <span className="event-edit-label">開始</span>
            <input
              type="datetime-local"
              className="event-edit-input"
              value={msToDatetimeLocalValue(draft.startMs, timeZone)}
              onChange={(e) =>
                setDraft({ ...draft, startMs: datetimeLocalValueToMs(e.target.value, timeZone) })
              }
            />
          </label>
          <label className="event-edit-field">
            <span className="event-edit-label">終了</span>
            <input
              type="datetime-local"
              className="event-edit-input"
              value={msToDatetimeLocalValue(draft.endMs, timeZone)}
              onChange={(e) =>
                setDraft({ ...draft, endMs: datetimeLocalValueToMs(e.target.value, timeZone) })
              }
            />
          </label>
        </div>
      )}

      {validationError && <p className="event-edit-error">{validationError}</p>}
      {saveError && <p className="event-edit-error">{saveError}</p>}

      <div className="event-edit-actions">
        <button
          type="submit"
          className="event-edit-save-btn"
          disabled={submitting || validationError !== null}
        >
          {submitting ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          className="event-edit-cancel-btn"
          onClick={onCancel}
          disabled={submitting}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}
