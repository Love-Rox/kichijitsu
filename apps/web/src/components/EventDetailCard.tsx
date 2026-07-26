import { useState } from "react";
import type { Ref } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { OccurrenceLink } from "../model/types";
import { calendarKey } from "../layout/keys";
import { resolveEventDetailMeetingView } from "../layout/eventDetailView";
import { clampPopoverPosition, stripHtmlToPlainText } from "./eventPopoverShared";
import { RsvpNotAttendeeError } from "../sync/eventRsvp";
import type { EventEditDraft } from "../sync/eventEdit";
import type { CalendarInfo } from "./calendarInfo";
import { MeetingProviderIcon } from "./meetingProviderIcon";
import { PlaceIcon, VideoIcon } from "./icons";
import { EventEditForm } from "./EventEditForm";

/**
 * クリック詳細ポップオーバー一式(2026-07-25 リファクタ フェーズ1a で EventBlock.tsx から
 * 移設)。移設理由: MonthView / AllDayBar / RailBand(variant="ooo") / RailBand(variant="workingLocation") の4ファイルは
 * このポップオーバーを使うためだけに、ドラッグ処理・useHourHeight・snap を抱えた 1100行超の
 * EventBlock.tsx を import していた。中身は一切変えていない(EventBlock.tsx からは互換のため
 * re-export しているので、既存の `from "./EventBlock"` も動く)。
 * CSS は現状 WeekGrid.css の .event-detail-* に同梱されたまま(別フェーズで扱う)。
 */

/**
 * EventDetailCard が要求する最小限の形。Occurrence (時刻予定) と AllDayOccurrence
 * (終日予定、フェーズ5) はどちらもこの形を構造的に満たすため、変換なしでそのまま
 * subject/groupMembers に渡せる(AllDayBar.tsx から再利用する狙い)。
 */
export interface EventDetailSubject {
  id: string;
  title: string;
  location?: string;
  description?: string;
  link?: OccurrenceLink;
  accountId?: string;
  calendarId?: string;
  /** Occurrence.isMirror / AllDayOccurrence.isMirror と同じ意味(自動生成 mirror かどうか) */
  isMirror?: boolean;
  /**
   * Occurrence.hasConference / AllDayOccurrence.hasConference と同じ意味(参加ステータス表示、
   * 2026-07-22)。true なら「オンライン会議あり」を表示する(下の EventDetailCard 参照)。
   */
  hasConference?: boolean;
  /**
   * Occurrence.conferenceUrl / AllDayOccurrence.conferenceUrl と同じ意味(2026-07-25)。
   * hangoutLink / conferenceData 由来の参加 URL。Meet 等は location に URL が入らないため、
   * 参加リンクの解決は resolveMeetingUrl(conferenceUrl, location) を通す。
   */
  conferenceUrl?: string;
}

export interface EventDetailCardProps {
  subject: EventDetailSubject;
  /** 表示済みの日時ラベル。時刻予定は「7月20日(月) 10:00 – 11:00」、終日予定は
   * 「7月20日〜7月22日」のように呼び出し側でフォーマットしてから渡す */
  dateTimeLabel: string;
  position: { x: number; y: number };
  /** 集約グループの全メンバー(フェーズ5)。1件なら subject 自身のみ */
  groupMembers: EventDetailSubject[];
  /** `${accountId}:${calendarId}` → カレンダー名/色。全所属の列挙に使う */
  calendarLookup: Map<string, CalendarInfo>;
  onClose: () => void;
  /**
   * 指定されていれば「削除」ボタン(インライン2段階確認)を表示する(フェーズ5)。
   * EventBlock は source==='google' のときだけこれを渡す(AllDayBar は渡さない=削除 UI 無し)。
   * 確定操作(「削除する」クリック)で onDelete() を呼んだ直後に onClose() でポップオーバーを
   * 閉じる — 削除は楽観的なので occurrence はすぐ画面から消え、失敗時の通知は
   * (このコンポーネントではなく) App.tsx 側の共通 saveError トーストが担う。
   */
  onDelete?: () => void;
  /**
   * 編集フォーム(フェーズ2、2026-07-22)。指定されていれば「編集」ボタンを表示する
   * (呼び出し側が sync/eventEdit.ts の isEditableEventSubject で判定済みの draft を渡す —
   * このコンポーネント自身は Occurrence/AllDayOccurrence どちらが元かを知らない)。
   * 日時入力の変換に必要な timeZone とセットで渡す。
   */
  editDraft?: EventEditDraft;
  timeZone?: string;
  /** シリーズ由来 (seriesId !== null) の予定は終日トグルを出さない(v1 未対応、EventEditForm.tsx 参照) */
  canToggleAllDay?: boolean;
  onSaveEdit?: (draft: EventEditDraft) => Promise<void>;
  /**
   * RSVP (フェーズ2、2026-07-22)。attendees の無い予定 (responseStatus undefined) は
   * ボタンを出さない ―― 呼び出し側が occurrence.responseStatus をそのまま渡す。
   */
  rsvpStatus?: RsvpResponseStatus;
  onRsvp?: (status: RsvpResponseStatus) => Promise<void>;
  /** React 19: 関数コンポーネントでも forwardRef 無しで ref を通常の prop として受け取れる */
  ref?: Ref<HTMLDivElement>;
}

/**
 * クリック詳細ポップオーバー。日時・場所・説明(プレーン化+最大10行程度でクランプ)・
 * Google で開くリンク・どのカレンダーか、を表示のみで持つ(編集機能は無し)。
 * 同一予定の集約(フェーズ5)で複数アカウント/カレンダーに重複がある場合は、
 * 全所属をカレンダー名の列で列挙する(groupMembers が2件以上のとき)。
 * .week-grid-days-viewport (overflow:hidden) の中に transform を持つ祖先
 * (.week-grid-days-strip) がいるため、position:fixed の containing block が
 * ビューポートではなくその祖先になってしまう問題を避けるべく document.body へ
 * createPortal している(portal は呼び出し側が張る)。
 * subject/dateTimeLabel を汎用化してあるため AllDayBar.tsx (終日レーン、フェーズ5)
 * からもそのまま再利用する。
 */
export function EventDetailCard({
  subject,
  dateTimeLabel,
  position,
  groupMembers,
  calendarLookup,
  onClose,
  onDelete,
  editDraft,
  timeZone,
  canToggleAllDay = false,
  onSaveEdit,
  rsvpStatus,
  onRsvp,
  ref,
}: EventDetailCardProps) {
  const { left, top } = clampPopoverPosition(position.x, position.y);
  const plainDescription = subject.description ? stripHtmlToPlainText(subject.description) : "";
  // 「会議 / 場所」行の出し分け(2026-07-25、Slack ハドル・Meet 等)。判定は純関数へ切り出し
  // 済み(layout/eventDetailView.ts、テストあり) ―― ここでは結果を並べるだけ。
  const meeting = resolveEventDetailMeetingView(subject);
  const memberCalendars = groupMembers
    .map((m) => {
      const info =
        m.accountId && m.calendarId
          ? calendarLookup.get(calendarKey(m.accountId, m.calendarId))
          : undefined;
      return info
        ? // カレンダー色が無いときの中立グレーは UI のトーン(データの色ではない)なので
          // theme.css のトークンを参照する ―― layout/eventColors.ts の
          // UNKNOWN_CALENDAR_COLOR と同じ値・同じ意味
          { key: m.id, color: info.backgroundColor ?? "var(--c-unknown-calendar)", summary: info.summary }
        : null;
    })
    .filter((info) => info !== null);

  // 編集モード(フェーズ2、2026-07-22): 既存の詳細カードの延長として、同じポップオーバーの
  // 中身を丸ごとフォームに差し替える(別モーダルは開かない ―― ユーザー要望「既存の詳細カードの
  // 延長で自然な方」)。editDraft/onSaveEdit/timeZone が揃っているときだけ「編集」ボタンを出す。
  const [editing, setEditing] = useState(false);
  const canEdit = editDraft !== undefined && onSaveEdit !== undefined && timeZone !== undefined;

  if (editing && editDraft !== undefined && onSaveEdit !== undefined && timeZone !== undefined) {
    const save = onSaveEdit;
    return (
      <div
        ref={ref}
        className="event-detail-popover event-detail-popover--editing"
        style={{ left, top }}
        role="dialog"
        aria-label={`${subject.title}を編集`}
      >
        <button type="button" className="event-detail-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <div className="event-detail-title">予定を編集</div>
        <EventEditForm
          initialDraft={editDraft}
          timeZone={timeZone}
          canToggleAllDay={canToggleAllDay}
          onSave={(draft) => save(draft).then(onClose)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <>
      {/*
       * 透明バックドロップ (2026-07-22): 詳細ポップオーバー/編集フォームが開いている間、
       * 外側クリックを「閉じるだけ」にする。pointerdown を stopPropagation して下のグリッド
       * (空き領域クリックでの新規作成・別予定のオープン) へ伝播させない ―― 以前は
       * useCloseOnOutsideOrEscape の document リスナーだけで閉じており、同じクリックが
       * グリッドにも当たって「閉じると同時に別操作が走る」不便があった (ユーザー指摘)。
       * 画面は暗くしない (background: transparent) ので、ポップオーバーの軽さは保つ。
       */}
      <div
        className="event-detail-backdrop"
        onPointerDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="event-detail-popover"
        style={{ left, top }}
        role="dialog"
        aria-label={subject.title}
      >
        <button type="button" className="event-detail-close" onClick={onClose} aria-label="閉じる">
          ×
        </button>
        <div className="event-detail-title">{subject.title}</div>
        <div className="event-detail-datetime">{dateTimeLabel}</div>
        {subject.isMirror === true && (
          // mirror には location/description が無い(無内容原則、docs/blocking.md)ため、
          // この説明文が詳細ポップオーバーの主内容になる
          <div className="event-detail-mirror-note">
            他のカレンダーの予定から自動でブロックされた時間です
          </div>
        )}
        {/*
         * オンライン/現地の手段表示 (参加ステータス表示、2026-07-22)。EventBlock のタイトル行の
         * 小アイコンと同じ判定基準(occurrence.hasConference/location)を、詳細ポップオーバーでは
         * テキストラベル付きで表示する(要件:「オンライン会議あり / 場所: {location}」)。
         * 参加リンク(下)を出せるときは、この汎用行は省く ―― 条件は
         * layout/eventDetailView.ts の showConferenceNote 参照(2026-07-25)。
         */}
        {meeting.showConferenceNote && (
          <div className="event-detail-conference">
            <VideoIcon width={12} height={12} />
            オンライン会議あり
          </div>
        )}
        {/*
         * 会議 URL のある予定 (Slack ハドル / Meet / Zoom / Teams、2026-07-25)。カード上は
         * アイコン+ラベルの表示のみなので、詳細ポップオーバーでは「実際に参加できるリンク」を
         * 出す(生 URL の行は置き換える ―― 全文は title 属性でホバー時に見える)。既存の
         * 「Google で開く」リンクと同じ流儀で、クリックの stopPropagation は付けない
         * (ポップオーバー内のクリックは useCloseOnOutsideOrEscape の contains 判定で
         * 「外側クリック」にならないため)。
         */}
        {meeting.meetingUrl && (
          <a
            className="event-detail-location event-detail-meeting-link"
            href={meeting.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={meeting.meetingUrl}
          >
            <MeetingProviderIcon provider={meeting.provider} width={12} height={12} />
            {meeting.meetingLinkLabel}
          </a>
        )}
        {/* 場所行は「location が参加リンクそのものではない」ときだけ出す(判定は
            layout/eventDetailView.ts の locationRow、2026-07-25)。 */}
        {meeting.locationRow && (
          <div className="event-detail-location">
            <PlaceIcon width={12} height={12} />
            場所: {meeting.locationRow}
          </div>
        )}
        {plainDescription && <div className="event-detail-description">{plainDescription}</div>}
        {subject.link?.url && (
          <a
            className="event-detail-link"
            href={subject.link.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Google で開く
          </a>
        )}
        {memberCalendars.length > 0 && (
          <div className="event-detail-calendar-list">
            {memberCalendars.map((info) => (
              <div className="event-detail-calendar" key={info.key}>
                <span
                  className="event-detail-calendar-dot"
                  style={{ background: info.color }}
                  aria-hidden="true"
                />
                {info.summary}
              </div>
            ))}
          </div>
        )}
        {/*
         * RSVP ボタン (フェーズ2、2026-07-22)。attendees の無い予定 (rsvpStatus undefined) は
         * 出さない(要件:「招待されていない=attendee でない」ことの指標として responseStatus の
         * 有無を使う)。onRsvp が無い(呼び出し側が渡さなかった)場合も出さない。
         */}
        {rsvpStatus !== undefined && onRsvp && <RsvpButtons current={rsvpStatus} onRsvp={onRsvp} />}
        {(onDelete || canEdit) && (
          <div className="event-detail-actions">
            {canEdit && (
              <button
                type="button"
                className="event-detail-text-btn event-detail-edit-btn"
                onClick={() => setEditing(true)}
              >
                編集
              </button>
            )}
            {onDelete && <EventDeleteControl onDelete={onDelete} onDeleted={onClose} />}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * 出欠 (RSVP) ボタン (フェーズ2、2026-07-22)。参加/未定/不参加の3択で、現在の自分の
 * 返信をハイライトする(Notion カレンダー風、ユーザー要望)。選択中は朱、非選択は
 * 墨/薄墨(朱は唯一アクセント原則、brand/README.md)。押している間はボタンを disabled にして
 * 二重送信を防ぎ、失敗時はインラインでエラーを出す(422 は専用メッセージ)。
 */
function RsvpButtons({
  current,
  onRsvp,
}: {
  current: RsvpResponseStatus;
  onRsvp: (status: RsvpResponseStatus) => Promise<void>;
}) {
  const [pending, setPending] = useState<RsvpResponseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: { status: RsvpResponseStatus; label: string }[] = [
    { status: "accepted", label: "参加" },
    { status: "tentative", label: "未定" },
    { status: "declined", label: "不参加" },
  ];

  function handleClick(status: RsvpResponseStatus) {
    if (status === current || pending) return;
    setPending(status);
    setError(null);
    onRsvp(status)
      .catch((err) => {
        console.error("kichijitsu: rsvp failed", err);
        setError(
          err instanceof RsvpNotAttendeeError ? "この予定には返信できません" : "返信に失敗しました",
        );
      })
      .finally(() => setPending(null));
  }

  return (
    <div className="event-detail-rsvp">
      <span className="event-detail-rsvp-label">出欠</span>
      <div className="event-detail-rsvp-buttons" role="group" aria-label="出欠の返信">
        {options.map((opt) => (
          <button
            key={opt.status}
            type="button"
            className={
              current === opt.status ? "event-detail-rsvp-btn is-selected" : "event-detail-rsvp-btn"
            }
            aria-pressed={current === opt.status}
            disabled={pending !== null}
            onClick={() => handleClick(opt.status)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {error && <span className="event-detail-rsvp-error">{error}</span>}
    </div>
  );
}

type DeleteControlState = "idle" | "confirming";

/**
 * 詳細ポップオーバーの「削除」導線。window.confirm を使わないインライン2段階確認
 * (CalendarSettingsPanel.tsx の AccountDisconnectControl と同じ流儀)。
 * 削除自体は楽観的 (App.tsx の handleDeleteOccurrence が即座に occurrence を消す) なので、
 * このコンポーネントは非同期の完了を待たない — 確定操作で onDelete() を呼んだら
 * そのままポップオーバーを閉じる (onDeleted、失敗時の通知は App.tsx の saveError トースト)。
 */
function EventDeleteControl({
  onDelete,
  onDeleted,
}: {
  onDelete: () => void;
  onDeleted: () => void;
}) {
  const [state, setState] = useState<DeleteControlState>("idle");

  if (state === "confirming") {
    return (
      <span className="event-detail-delete-confirm">
        削除しますか？
        <button
          type="button"
          className="event-detail-text-btn"
          onClick={() => {
            onDelete();
            onDeleted();
          }}
        >
          削除する
        </button>
        <button type="button" className="event-detail-text-btn" onClick={() => setState("idle")}>
          やめる
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="event-detail-text-btn event-detail-delete-btn"
      onClick={() => setState("confirming")}
    >
      削除
    </button>
  );
}
