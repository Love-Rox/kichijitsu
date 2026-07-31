import { useState } from "react";
import type { Ref } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { EventAttendee, OccurrenceLink } from "../model/types";
import { calendarKey } from "../layout/keys";
import { resolveEventDetailMeetingView } from "../layout/eventDetailView";
import {
  buildGuestListView,
  GUEST_PREVIEW_COUNT,
  GUEST_STATUS_LABEL,
  type GuestListView,
} from "../layout/guestList";
import { clampPopoverPosition, stripHtmlToPlainText } from "./eventPopoverShared";
import { RsvpNotAttendeeError } from "../sync/eventRsvp";
import {
  GuestNotOrganizerError,
  parseGuestEmailInput,
  type GuestChange,
  type GuestEmailError,
} from "../sync/eventGuests";
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
  /**
   * Occurrence.attendees / AllDayOccurrence.attendees と同じ意味(参加者の表示、2026-07-30)。
   * 値があれば「ゲスト」欄を出す(下の GuestSection)。並び替え・会議室の分離・人数の
   * 数え方は layout/guestList.ts の純関数が決める。
   */
  attendees?: EventAttendee[];
  /** Occurrence.attendeesOmitted と同じ意味(一覧が全員ぶんではない、2026-07-30)。 */
  attendeesOmitted?: boolean;
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
   * deleteAsksGuestNotify が true のときだけ、確定操作はインライン確認ではなく
   * 「削除」ボタンそのものになる (下の deleteAsksGuestNotify 参照)。
   */
  onDelete?: () => void;
  /**
   * 削除でゲストへの通知を訊くか (2026-07-31、sync/guestNotify.ts の shouldAskGuestNotify で
   * 呼び出し側が判定済み)。true のとき「削除」はインライン2段階確認を**出さず**、
   * その場で onDelete() を呼ぶ ―― 呼び出し側 (App.tsx) が確認ダイアログを開き、
   * 「削除するか」と「通知を送るか」を一度に訊く。押す回数は2回のままで変わらない。
   *
   * **false/未指定なら従来どおりインライン2段階確認**。ゲストのいない予定・自分が主催で
   * ない予定 (削除のほとんど) は 2026-07-31 以前と1pxも変わらない。
   */
  deleteAsksGuestNotify?: boolean;
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
  /**
   * ゲスト (参加者) の追加・削除 (2026-07-31)。**渡されたときだけ**ゲスト欄が編集できる
   * ―― 呼び出し側が sync/eventGuests.ts の canEditGuests で判定済み (自分が主催の、
   * 繰り返しでない Google 予定のみ)。渡さなければ従来どおり表示のみ。
   * 422 (主催者でない) は GuestNotOrganizerError を reject する取り決め。
   */
  onEditGuests?: (change: GuestChange) => Promise<void>;
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
  deleteAsksGuestNotify,
  editDraft,
  timeZone,
  canToggleAllDay = false,
  onSaveEdit,
  rsvpStatus,
  onRsvp,
  onEditGuests,
  ref,
}: EventDetailCardProps) {
  const { left, top } = clampPopoverPosition(position.x, position.y);
  const plainDescription = subject.description ? stripHtmlToPlainText(subject.description) : "";
  // 「会議 / 場所」行の出し分け(2026-07-25、Slack ハドル・Meet 等)。判定は純関数へ切り出し
  // 済み(layout/eventDetailView.ts、テストあり) ―― ここでは結果を並べるだけ。
  const meeting = resolveEventDetailMeetingView(subject);
  // ゲスト欄 (参加者の表示、2026-07-30)。整形は純関数へ切り出し済み (layout/guestList.ts、
  // テストあり) ―― ここでは結果を並べるだけ。参加者のいない予定は null が返り、欄ごと出ない。
  const guestList = buildGuestListView(subject.attendees, subject.attendeesOmitted);
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
        {/*
         * ゲスト (参加者) 欄 (2026-07-30、2026-07-31 に追加・削除を追加)。
         * 場所・説明の後、カレンダー所属の前に置く: 参加者は予定の中身であって、
         * 「どのカレンダーにあるか」は予定の入れ物の話なので、中身を先に読ませる。
         *
         * **参加者が1人もいなくても、編集できる予定なら欄を出す** ―― そうしないと
         * 「自分だけの予定に最初の1人を招待する」という一番よくある操作の入口が
         * どこにも無くなる (guestList は参加者ゼロで null を返す)。
         */}
        {(guestList || onEditGuests) && (
          <GuestSection
            view={guestList}
            attendees={subject.attendees}
            onEditGuests={onEditGuests}
          />
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
            {onDelete && (
              <EventDeleteControl
                onDelete={onDelete}
                onDeleted={onClose}
                askGuestNotify={deleteAsksGuestNotify}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** 入力の弾き方を日本語にする。理由ごとに違う文にするのは、直し方が違うため */
const GUEST_EMAIL_ERROR_TEXT: Record<GuestEmailError, string> = {
  empty: "メールアドレスを入力してください",
  invalid: "メールアドレスの形になっていません",
  tooLong: "メールアドレスが長すぎます",
  duplicate: "すでにゲストに入っています",
  self: "自分自身は追加できません",
};

/**
 * ゲスト (参加者) 欄 (2026-07-30、2026-07-31 に追加・削除を追加)。
 *
 * 見た目は既存の意匠に寄せてある ―― 見出しの体裁はカレンダー所属の列
 * (.event-detail-calendar-list) と同じ「上に区切り線を引いた小さな塊」、行の文字色は
 * 場所・説明と同じ薄墨。新しい色は一切足していない: 応答状態は**語彙と形**で表す
 * (参加/未定/不参加/未返信 の文言 + 不参加の打ち消し線 + 未返信/未定の淡さ)。
 * これは予定カード側の描き分け(未返信=輪郭だけ、不参加=打ち消し線、未定=淡い)と
 * 同じ読み方なので、利用者が新しい対応表を覚える必要が無い。
 *
 * **人数が多いときに詳細カードが破綻しない**ようにするのがこの欄の一番の設計点:
 *   - 畳んだ状態では先頭 GUEST_PREVIEW_COUNT 人だけ。残りは「他 N 人を表示」の中。
 *   - 開いても一覧自体に max-height を持たせて中でスクロールさせる(CSS 側)。
 *     ポップオーバー全体 (max-height 420px) を参加者だけで埋めてしまうと、その下の
 *     カレンダー所属・出欠ボタン・編集/削除に届かなくなるため。
 *
 * ## 通知メールを黙って送らない (2026-07-31)
 * ゲストを足す/外すと Google から**関係者全員にメールが飛ぶ** (sendUpdates=all)。
 * これは選ばせるべき設定に見えるが、**選ばせない**ことにした ―― 公式に、通知を
 * 送らない (`none`) と「events not syncing to external calendars or events being lost
 * altogether for some users」と警告があり、`externalOnly` でも Google カレンダー側の
 * 招待設定によっては相手に予定が現れない。つまり**この操作で安全な値は all しか無く**、
 * 選択肢を出すことは「壊れる選択肢」を出すことになる。
 * 代わりに、**押す前に必ず読める場所に書く**: 欄の中の注記と、ボタンの文言そのもの
 * (「招待して追加」「通知して外す」)。黙って送らない、が守っていること。
 *
 * @param view 参加者ゼロの予定では null。編集できるときはそれでも欄を出す (追加の入口)
 * @param onEditGuests 省略時は従来どおり表示のみ (呼び出し側が canEditGuests で判定済み)
 */
function GuestSection({
  view,
  attendees,
  onEditGuests,
}: {
  view: GuestListView | null;
  attendees?: EventAttendee[];
  onEditGuests?: (change: GuestChange) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draftEmail, setDraftEmail] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  /** 送信中のアドレス (追加でも削除でも)。二重送信 = 招待メールの重複を防ぐ */
  const [pending, setPending] = useState<string | null>(null);
  /** 「外しますか?」を出している行のアドレス。削除は取り返しがつかないので必ず2段階 */
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const guests = view?.guests ?? [];
  const hiddenCount = guests.length - GUEST_PREVIEW_COUNT;
  const shown = expanded ? guests : guests.slice(0, GUEST_PREVIEW_COUNT);

  function runChange(change: GuestChange, key: string) {
    if (!onEditGuests || pending) return;
    setPending(key);
    setActionError(null);
    onEditGuests(change)
      .then(() => {
        setDraftEmail("");
        setInputError(null);
        setConfirmingRemoval(null);
      })
      .catch((err) => {
        console.error("kichijitsu: guest edit failed", err);
        setActionError(
          err instanceof GuestNotOrganizerError
            ? "この予定のゲストは変更できません (主催者のみ)"
            : "変更できませんでした（元に戻しました）",
        );
      })
      .finally(() => setPending(null));
  }

  function handleAdd() {
    const parsed = parseGuestEmailInput(draftEmail, attendees);
    if (!parsed.ok) {
      setInputError(GUEST_EMAIL_ERROR_TEXT[parsed.reason]);
      return;
    }
    setInputError(null);
    runChange({ addEmails: [parsed.email] }, parsed.email);
  }

  return (
    <div className="event-detail-guests">
      {view && (
        <div className="event-detail-guests-head">
          <span className="event-detail-guests-count">{view.countLabel}</span>
          {view.summaryLabel && (
            <span className="event-detail-guests-summary">{view.summaryLabel}</span>
          )}
        </div>
      )}
      {/* 参加者ゼロで編集できる予定。人数も内訳も出しようが無いので、見出しだけ置く */}
      {!view && (
        <div className="event-detail-guests-head">
          <span className="event-detail-guests-count">ゲスト</span>
        </div>
      )}
      {/*
       * 会議室・機材 (resource) は人ではないので一覧に混ぜず、場所行と同じピンアイコンで
       * 1行にまとめる(押さえてある部屋が分かればよく、部屋ごとの「応答状態」に意味は無い)。
       */}
      {view && view.rooms.length > 0 && (
        <div className="event-detail-guests-rooms">
          <PlaceIcon width={12} height={12} />
          {view.rooms.join("、")}
        </div>
      )}
      {shown.length > 0 && (
        <ul className={expanded ? "event-detail-guest-list is-expanded" : "event-detail-guest-list"}>
          {shown.map((guest) => (
            <li key={guest.key} className={`event-detail-guest is-${guest.responseStatus}`}>
              <span className="event-detail-guest-who">
                <span className="event-detail-guest-name">
                  {guest.label}
                  {guest.note && <span className="event-detail-guest-note">{guest.note}</span>}
                </span>
                {guest.subLabel && (
                  <span className="event-detail-guest-mail">{guest.subLabel}</span>
                )}
              </span>
              {/*
               * 右端は「応答状態」か「外す導線」のどちらか。確認中の行だけ状態の代わりに
               * 2段階目を出す ―― 行を増やさずに済み、どの人を外そうとしているかが動かない。
               */}
              {onEditGuests && guest.removable && confirmingRemoval === guest.email ? (
                <span className="event-detail-guest-confirm">
                  <button
                    type="button"
                    className="event-detail-text-btn"
                    disabled={pending !== null}
                    onClick={() => runChange({ removeEmails: [guest.email!] }, guest.email!)}
                  >
                    通知して外す
                  </button>
                  <button
                    type="button"
                    className="event-detail-text-btn"
                    disabled={pending !== null}
                    onClick={() => setConfirmingRemoval(null)}
                  >
                    やめる
                  </button>
                </span>
              ) : (
                <span className="event-detail-guest-status">
                  {GUEST_STATUS_LABEL[guest.responseStatus]}
                  {onEditGuests && guest.removable && (
                    <button
                      type="button"
                      className="event-detail-guest-remove"
                      aria-label={`${guest.label} を外す`}
                      disabled={pending !== null}
                      onClick={() => {
                        setActionError(null);
                        setConfirmingRemoval(guest.email!);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="event-detail-text-btn event-detail-guests-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "折りたたむ" : `他 ${hiddenCount} 人を表示`}
        </button>
      )}
      {onEditGuests && (
        <div className="event-detail-guest-add">
          <input
            type="email"
            className="event-edit-input event-detail-guest-input"
            placeholder="メールアドレスを追加"
            aria-label="ゲストのメールアドレス"
            value={draftEmail}
            disabled={pending !== null}
            onChange={(e) => {
              setDraftEmail(e.target.value);
              if (inputError) setInputError(null);
            }}
            onKeyDown={(e) => {
              // ポップオーバーの Escape (閉じる) は殺さない。Enter だけ拾って追加する
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <button
            type="button"
            className="event-detail-text-btn event-detail-guest-add-btn"
            disabled={pending !== null || draftEmail.trim() === ""}
            onClick={handleAdd}
          >
            招待して追加
          </button>
        </div>
      )}
      {onEditGuests && (
        // 「黙ってメールを送らない」ための注記。押す前に必ず目に入る位置に置く
        <p className="event-detail-guest-note-line">
          追加・外すと、Google からゲスト全員に通知メールが届きます。
        </p>
      )}
      {inputError && <p className="event-detail-guest-error">{inputError}</p>}
      {actionError && <p className="event-detail-guest-error">{actionError}</p>}
    </div>
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
 * (askGuestNotify のときだけ handleDeleteOccurrence はすぐには消さず、確認ダイアログを
 * 開いてから消す ―― どちらにせよここは「呼んで閉じる」で変わらない。)
 *
 * askGuestNotify (2026-07-31) が true のときだけ、この**インライン確認を省いて**そのまま
 * onDelete() を呼ぶ ―― 呼び出し側が確認ダイアログ (MoveConfirmDialog purpose='delete') を
 * 開き、「削除するか」と「ゲストへの通知」をまとめて訊くため。ここで「削除しますか?」を
 * 出してからダイアログでもう一度「削除しますか?」を出すと、同じ問いが2回続くうえ押す回数も
 * 3回に増える。**問いかけの場所が変わるだけで、回数は2回のまま**にしてある。
 * false のときは 2026-07-31 以前と1文字も変わらない (削除のほとんどがこちら)。
 */
function EventDeleteControl({
  onDelete,
  onDeleted,
  askGuestNotify = false,
}: {
  onDelete: () => void;
  onDeleted: () => void;
  askGuestNotify?: boolean;
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
      onClick={() => {
        if (!askGuestNotify) {
          setState("confirming");
          return;
        }
        // 確認はこのあと開く確認ダイアログが引き受ける (上のコメント参照)。
        // ポップオーバーは先に閉じる ―― ダイアログはモーダルで画面中央に出るため、
        // 背後にカードが残っていても操作できず、閉じたほうが読みやすい。
        onDelete();
        onDeleted();
      }}
    >
      削除
    </button>
  );
}
