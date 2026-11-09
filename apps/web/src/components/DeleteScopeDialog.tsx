import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { plainDateOfMs } from "../layout/dayTime";
import type { Occurrence } from "../model/types";
import { DEFAULT_GUEST_NOTIFY, type GuestNotify } from "../sync/guestNotify";
import { MAX_RANGE_DELETE, type DeleteScope } from "../sync/recurrenceDelete";
import { NOTIFY_OPTIONS } from "./MoveConfirmDialog";
import "./MoveConfirmDialog.css";

export interface DeleteScopeDialogProps {
  occurrence: Occurrence;
  timeZone: string;
  /** ゲストへの通知も訊くか(ゲストがいて自分が主催のとき) */
  askNotify: boolean;
  /** 「この回から指定の日まで」で消える回数。見出しに出す(上限 MAX_RANGE_DELETE) */
  countRange: (occurrence: Occurrence, until: string) => Promise<number>;
  onConfirm: (scope: DeleteScope, notify: GuestNotify, until?: string) => void;
  onCancel: () => void;
}

const SCOPE_LABEL: Record<DeleteScope, string> = {
  this: "この予定のみ",
  range: "この予定から指定の日まで",
  all: "すべての予定",
};
const SCOPES: readonly DeleteScope[] = ["this", "range", "all"];

/**
 * 繰り返し予定の削除の確認 (2026-11-09)。「この予定のみ / この予定から指定の日まで / すべての予定」
 * を選ばせる。見た目は MoveConfirmDialog (移動・編集・ゲストのいる予定の削除) と同じクラスを使い回し、
 * 新しい意匠は足していない。
 *
 * - 「指定の日まで」は、その日を含む。消える回数を数えて見せ、上限 (MAX_RANGE_DELETE) を超える分は
 *   消さない(上限を超えるなら、期間を分けるか「すべて」を使う)。
 * - 「すべて」はシリーズごと消す。取り消せないので、確定のボタンにもそう書く。
 */
export function DeleteScopeDialog({
  occurrence,
  timeZone,
  askNotify,
  countRange,
  onConfirm,
  onCancel,
}: DeleteScopeDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const firstDay = plainDateOfMs(occurrence.startMs, timeZone).toString();
  const [scope, setScope] = useState<DeleteScope>("this");
  const [until, setUntil] = useState<string>(firstDay);
  const [count, setCount] = useState<number | null>(null);
  const [notify, setNotify] = useState<GuestNotify>(DEFAULT_GUEST_NOTIFY);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // 範囲を選んでいる間、消える回数を数える。日付の入力が途中のとき(空・不正)は数えない
  useEffect(() => {
    if (scope !== "range") return;
    let cancelled = false;
    try {
      Temporal.PlainDate.from(until);
    } catch {
      return;
    }
    void countRange(occurrence, until).then((n) => {
      if (!cancelled) setCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, until, occurrence, countRange]);

  const rangeInvalid = scope === "range" && (!until || until < firstDay);
  const confirmLabel =
    scope === "all"
      ? "すべて削除する"
      : scope === "range" && count !== null
        ? `${count} 回分を削除する`
        : "削除する";

  function confirm() {
    if (rangeInvalid) return;
    onConfirm(scope, notify, scope === "range" ? until : undefined);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div
      className="move-confirm-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="move-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label="繰り返し予定の削除"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <p className="move-confirm-title">{`「${occurrence.title}」を削除しますか?`}</p>

        <fieldset className="move-confirm-scope">
          <legend className="move-confirm-scope-legend">削除の範囲</legend>
          {SCOPES.map((value) => (
            <label key={value} className="move-confirm-scope-option">
              <input
                type="radio"
                name="delete-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
              />
              {SCOPE_LABEL[value]}
            </label>
          ))}
        </fieldset>

        {scope === "range" && (
          <>
            <label className="move-confirm-scope-option">
              最後の日
              <input
                type="date"
                value={until}
                min={firstDay}
                onChange={(e) => {
                  setUntil(e.target.value);
                  setCount(null);
                }}
              />
            </label>
            <p className="move-confirm-note">
              {rangeInvalid
                ? "最後の日は、この予定の日以降にしてください。"
                : count === null
                  ? "消える回数を数えています…"
                  : count >= MAX_RANGE_DELETE
                    ? `この予定から ${MAX_RANGE_DELETE} 回分(上限)を消します。それ以降は残るので、続きは期間を分けるか「すべての予定」を使ってください。`
                    : `この予定から最後の日まで、${count} 回分を消します(すでに消した回は数えません)。`}
            </p>
          </>
        )}
        {scope === "all" && (
          <p className="move-confirm-note">
            この繰り返し予定のすべての回(過去の回も含む)を、Google カレンダーからも消します。
          </p>
        )}

        {askNotify && (
          <>
            <fieldset className="move-confirm-scope">
              <legend className="move-confirm-scope-legend">ゲストへの通知</legend>
              {NOTIFY_OPTIONS.map((option) => (
                <label key={option.value} className="move-confirm-scope-option">
                  <input
                    type="radio"
                    name="delete-scope-notify"
                    value={option.value}
                    checked={notify === option.value}
                    onChange={() => setNotify(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <p className="move-confirm-note">
              「送信しない」でも、Google カレンダー以外のゲストにはメールが届く ――
              相手のカレンダーを取り消す手段が他に無いためだ。Google
              カレンダーのゲストの予定は、メールが無くても同期で消える。
            </p>
          </>
        )}

        <div className="move-confirm-actions">
          <button
            type="button"
            className="move-confirm-confirm-btn"
            disabled={rangeInvalid}
            onClick={confirm}
          >
            {confirmLabel}
          </button>
          <button type="button" className="move-confirm-cancel-btn" onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
