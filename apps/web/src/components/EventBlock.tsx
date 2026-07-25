import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { Occurrence } from "../model/types";
import { snapEndMs, snapStartMs } from "../layout/snap";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { useHourHeight } from "../hooks/useHourHeight";
import { useHoverTooltip } from "../hooks/useHoverTooltip";
import {
  DAY_COLUMN_INSET_PX,
  formatDetailDateTime,
  formatRange,
  formatTime,
  isBusyPlaceholder,
  locationLineClamp,
  msToTopPx,
  pxToMinutes,
} from "../layout/gridMetrics";
import {
  buildCalendarStripeColors,
  resolveBusyColor,
  resolveDisplayColor,
} from "../layout/eventColors";
import {
  draftFromOccurrence,
  isEditableEventSubject,
  type EventEditDraft,
} from "../sync/eventEdit";
import {
  detectMeetingProvider,
  meetingLocationLabel,
  meetingProviderLabel,
  resolveMeetingUrl,
} from "../layout/meetingLinks";
import { PlaceIcon, VideoIcon } from "./icons";
import type { CalendarInfo } from "./calendarInfo";
import { MeetingProviderIcon } from "./meetingProviderIcon";
import { EventDetailCard } from "./EventDetailCard";

/*
 * 互換のための re-export(リファクタ フェーズ1a、2026-07-25)。
 * CalendarInfo は10ファイル以上、EventDetailCard は4ファイルが `from "./EventBlock"` で
 * 引いているため、定義を別ファイルへ移しても既存の import が動くようにここへ通す。
 * 参照元の import 文の書き換えは別コミットで行う方針(この変更を「移設だけ」に留めるため)。
 */
export type { CalendarInfo } from "./calendarInfo";
export { EventDetailCard } from "./EventDetailCard";

interface EventBlockProps {
  /** カード上で実際に操作対象になる代表 occurrence(集約グループの主コピー) */
  occurrence: Occurrence;
  /**
   * この occurrence が属す集約グループの全メンバー(フェーズ5の同一予定集約)。
   * 1件なら occurrence 自身のみを含む配列。2件以上でカード上に色ドットを表示し、
   * 詳細ポップオーバーで全所属を列挙する
   */
  groupMembers: Occurrence[];
  /** その日の 0:00 からの px オフセット（親が packColumns の結果から計算済み） */
  top: number;
  height: number;
  /** 使用可能幅(日列の左右インセットを除いた内側)に対する % (0-100)。カスケード表示の座標 */
  leftPct: number;
  widthPct: number;
  /**
   * 日列左端の px インセット(2026-07-22、不在レール矩形化。同 07-22 横ずれ解消
   * リファクタでレール幅の求め方を変更)。省略時は従来どおり DAY_COLUMN_INSET_PX。
   * 呼び出し元 (DayColumn.tsx) はその日の統合レール(.day-rail、OOO+勤務場所)の
   * 列パッキング結果(layout/railStack.ts)から必要な最大列数を求め、
   * layout/gridMetrics.ts の dayColumnLeftInsetPx() を呼んでここへ渡す —
   * レール(幅 12px × 列数)と予定カードが重ならないよう、レールのある日だけ
   * 左インセットを広げるため。右インセットは常に DAY_COLUMN_INSET_PX で不変
   * (day-activity-rail は右端固定のため)。
   */
  leftInsetPx?: number;
  /** カスケード表示の重なり順(0-based 列番号)。z-index の基準にする */
  stackIndex: number;
  isCompact: boolean;
  /**
   * この occurrence (非 Busy) が重なっている Busy のカレンダー色一覧(WeekGrid 側で
   * busyOverlapColors により算出済み、重複排除・最大3色)。空でなければカード端に
   * 「予定あり」バッジを出し、どのカレンダーの Busy にブロックされているかを色で示す
   * (ユーザー決定 2026-07-20: Busy は最背面のまま、実予定側にバッジを出す方式)。
   */
  blockedByBusyColors?: string[];
  timeZone: string;
  /** このブロックが今属している日の週内インデックス (0=月 .. 6=日) */
  dayIndex: number;
  /** このブロックが今属している日の 0:00 (epoch ms) */
  dayStartMs: number;
  /** このブロックが属する週の7日ぶんの 0:00 (epoch ms)。日をまたぐ移動の着地点計算に使う */
  weekDayStarts: readonly number[];
  /**
   * ドラッグ確定時に呼ばれる。kind (フェーズ2、2026-07-22 移動確認ダイアログ) は
   * "move"(ドラッグ移動)/"resize"(リサイズ)の区別 — WeekGrid.handleCommit がこれを見て
   * "move" のときだけ確認ダイアログを挟む(リサイズは現状どおり即確定、ユーザー決定)。
   */
  onCommit: (updated: Occurrence, kind: "move" | "resize") => void;
  /** `${accountId}:${calendarId}` → カレンダー名/色。詳細ポップオーバーの「どのカレンダーか」表示用 */
  calendarLookup: Map<string, CalendarInfo>;
  /**
   * 詳細ポップオーバーの「削除」導線から呼ばれる(フェーズ5)。source==='google' の
   * ときだけ EventDetailCard に削除ボタンを渡す(呼び出しは常にこの occurrence 自身)。
   * ローカル予定は当面削除 UI を出さない(将来対応)。
   */
  onDelete: (occurrence: Occurrence) => void;
  /**
   * 詳細ポップオーバーの編集フォーム「保存」から呼ばれる(フェーズ2、2026-07-22)。
   * 成功で resolve、失敗で reject(EventEditForm がエラー表示してフォームを開いたままにする)。
   */
  onSaveEdit: (occurrence: Occurrence, draft: EventEditDraft) => Promise<void>;
  /**
   * 詳細ポップオーバーの RSVP ボタンから呼ばれる(フェーズ2、2026-07-22)。
   * 422 (not_an_attendee) は RsvpNotAttendeeError を reject する取り決め(sync/eventRsvp.ts 参照)。
   */
  onRsvp: (occurrence: Occurrence, status: RsvpResponseStatus) => Promise<void>;
}

interface DragState {
  kind: "move" | "resize";
  pointerId: number;
  moved: boolean;
  startClientX: number;
  startClientY: number;
  /** ドラッグ開始時に測った、週7列グリッドの左端・上端・列幅 (px, viewport 座標) */
  gridLeft: number;
  gridTop: number;
  columnWidthPx: number;
  /** 移動ドラッグ用: 掴んだ位置とブロック上端との差（分） */
  grabOffsetMinutes: number;
  originalStartMs: number;
  originalEndMs: number;
  originalTopPx: number;
  originalHeightPx: number;
  weekDayStarts: readonly number[];
  dayStartMs: number;
  pendingStartMs: number;
  pendingEndMs: number;
  badgeEl: HTMLDivElement;
}

const CLICK_THRESHOLD_PX = 4;

/**
 * 週7列グリッドの左端からのドラッグ着地列を [0,6] に収めるためだけの、
 * このファイル内限定のクランプ(ポップオーバー位置の共有版は eventPopoverShared.ts の
 * clampPopoverPosition が内部で使っている別インスタンス)。
 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 週グリッド上の1イベントブロック。移動・リサイズのドラッグ操作を持つ。
 *
 * 規律: pointermove 中は React の state を一切更新しない。ドラッグ中は
 * このコンポーネント自身の DOM ノードに ref 経由で直接 style を書き込み、
 * pointerup で確定した瞬間だけ onCommit (= store.update) を呼ぶ。
 */
export function EventBlock({
  occurrence,
  groupMembers,
  top,
  height,
  leftPct,
  widthPct,
  leftInsetPx: leftInsetPxProp,
  stackIndex,
  isCompact,
  blockedByBusyColors,
  timeZone,
  dayIndex,
  dayStartMs,
  weekDayStarts,
  onCommit,
  calendarLookup,
  onDelete,
  onSaveEdit,
  onRsvp,
}: EventBlockProps) {
  // 時間軸ズーム(2026-07-25): ドラッグ中の px⇔分 変換に使う現在のズーム値
  // (WeekGrid が張る context 経由。hooks/useHourHeight.tsx 参照)
  const hourHeight = useHourHeight();
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const detailCardRef = useRef<HTMLDivElement>(null);
  // クリック(≒詳細ポップオーバーを開く座標)。null の間は非表示
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  // ホバーツールチップ(hooks/useHoverTooltip.ts に共通化、2026-07-25)。
  // ドラッグ中は出さない(suppress) ―― pointerenter 時と待ち時間の発火時の両方で
  // dragRef を見るため、待ち時間の途中でドラッグが始まった場合も出ない
  const tooltip = useHoverTooltip(
    () => ({
      title: occurrence.title,
      rangeLabel: formatRange(occurrence.startMs, occurrence.endMs, timeZone),
      // 会議 URL はラベルに置き換える(2026-07-25)。ツールチップは1行なので生 URL だと
      // 溢れて読めない ―― カード上の場所行と同じ表示に揃える
      location: meetingLocationLabel(occurrence.location),
    }),
    { suppress: () => dragRef.current !== null },
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleKeyDown = useRef((e: KeyboardEvent) => {
    if (e.key === "Escape") cancelDrag();
  }).current;

  function createBadge(): HTMLDivElement {
    const badge = document.createElement("div");
    badge.className = "drag-badge";
    return badge;
  }

  function cancelDrag() {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el) return;
    window.removeEventListener("keydown", handleKeyDown);
    try {
      el.releasePointerCapture(ds.pointerId);
    } catch {
      /* すでに解放済みなら無視 */
    }
    el.classList.remove("event--dragging");
    el.style.transform = "";
    if (ds.kind === "resize") {
      el.style.height = `${ds.originalHeightPx}px`;
    }
    ds.badgeEl.remove();
    dragRef.current = null;
  }

  // アンマウント時にドラッグ中なら後始末（バッジ・リスナーの残留防止）。
  // ホバー中のツールチップ(共有 DOM ノード)の後始末は useHoverTooltip 側が持つ
  // (この effect より先に登録されているので、従来と同じ「ツールチップ → ドラッグ」の順で消える)
  useEffect(() => {
    return () => {
      const ds = dragRef.current;
      if (!ds) return;
      window.removeEventListener("keydown", handleKeyDown);
      ds.badgeEl.remove();
      dragRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 詳細ポップオーバーが開いている間: 外側クリック・Escape で閉じる(AllDayBar と共通の hook)
  useCloseOnOutsideOrEscape(detailPos !== null, detailCardRef, () => setDetailPos(null));

  function beginDrag(e: ReactPointerEvent<HTMLDivElement>, kind: DragState["kind"]) {
    if (e.button !== 0) return;
    const el = elRef.current;
    const gridEl = el?.parentElement?.parentElement;
    if (!el || !gridEl) return;
    tooltip.hide(); // 操作を始めたらツールチップは即座に消す(ドラッグ中は表示しない)
    el.setPointerCapture(e.pointerId);
    const gridRect = gridEl.getBoundingClientRect();
    // モバイル対応フェーズ2: 列数は固定7ではなく weekDayStarts.length (=dayCount) に従う
    // (週ビュー=7、day3/day1 ビューではそれぞれ3/1)
    const columnWidthPx = gridRect.width / weekDayStarts.length;
    const grabOffsetMinutes =
      kind === "move"
        ? pxToMinutes(e.clientY - gridRect.top, hourHeight) - pxToMinutes(top, hourHeight)
        : 0;

    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      moved: false,
      startClientX: e.clientX,
      startClientY: e.clientY,
      gridLeft: gridRect.left,
      gridTop: gridRect.top,
      columnWidthPx,
      grabOffsetMinutes,
      originalStartMs: occurrence.startMs,
      originalEndMs: occurrence.endMs,
      originalTopPx: top,
      originalHeightPx: height,
      weekDayStarts,
      dayStartMs,
      pendingStartMs: occurrence.startMs,
      pendingEndMs: occurrence.endMs,
      badgeEl: createBadge(),
    };
    window.addEventListener("keydown", handleKeyDown);
  }

  function handlePointerDownMove(e: ReactPointerEvent<HTMLDivElement>) {
    beginDrag(e, "move");
  }

  function handlePointerDownResize(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    beginDrag(e, "resize");
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el || ds.pointerId !== e.pointerId) {
      // ドラッグ中でなければ、表示中のツールチップをポインタに追従させる(DOM 直書き、state 更新なし)
      if (!ds) tooltip.onPointerMove(e);
      return;
    }

    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    if (!ds.moved && Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX) {
      ds.moved = true;
      el.classList.add("event--dragging");
      document.body.appendChild(ds.badgeEl);
    }
    if (!ds.moved) return;

    if (ds.kind === "move") {
      const targetIndex = clamp(
        Math.floor((e.clientX - ds.gridLeft) / ds.columnWidthPx),
        0,
        ds.weekDayStarts.length - 1,
      );
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop, hourHeight);
      const rawStartMinutes = pointerMinutes - ds.grabOffsetMinutes;
      const targetDayStartMs = ds.weekDayStarts[targetIndex];
      const rawStartMs = targetDayStartMs + rawStartMinutes * 60_000;
      const snappedStart = snapStartMs(rawStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      });
      const durationMs = ds.originalEndMs - ds.originalStartMs;
      const snappedEnd = snappedStart + durationMs;

      const newTopPx = msToTopPx(snappedStart, targetDayStartMs, hourHeight);
      const dxPx = (targetIndex - dayIndex) * ds.columnWidthPx;
      const dyPx = newTopPx - ds.originalTopPx;
      el.style.transform = `translate(${dxPx}px, ${dyPx}px)`;

      ds.pendingStartMs = snappedStart;
      ds.pendingEndMs = snappedEnd;
      ds.badgeEl.textContent = formatRange(snappedStart, snappedEnd, timeZone);
    } else {
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop, hourHeight);
      const rawEndMs = ds.dayStartMs + pointerMinutes * 60_000;
      const snappedEnd = snapEndMs(rawEndMs, ds.originalStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      });
      const newHeightPx = Math.max(
        msToTopPx(snappedEnd, ds.dayStartMs, hourHeight) - ds.originalTopPx,
        4,
      );
      el.style.height = `${newHeightPx}px`;

      ds.pendingEndMs = snappedEnd;
      ds.badgeEl.textContent = formatRange(ds.originalStartMs, snappedEnd, timeZone);
    }

    ds.badgeEl.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const ds = dragRef.current;
    const el = elRef.current;
    if (!ds || !el || ds.pointerId !== e.pointerId) return;
    window.removeEventListener("keydown", handleKeyDown);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    ds.badgeEl.remove();

    if (!ds.moved) {
      // 移動閾値未満はクリック扱い: 詳細ポップオーバーを開く
      dragRef.current = null;
      tooltip.hide();
      setDetailPos({ x: e.clientX, y: e.clientY });
      return;
    }

    el.classList.remove("event--dragging");
    el.style.transform = "";

    if (ds.kind === "move") {
      onCommit({ ...occurrence, startMs: ds.pendingStartMs, endMs: ds.pendingEndMs }, "move");
    } else {
      onCommit({ ...occurrence, endMs: ds.pendingEndMs }, "resize");
    }
    dragRef.current = null;
  }

  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    cancelDrag();
  }

  // リサイズ中は height への React 再レンダーの上書きを止める。move 中に
  // 何らかの理由で親が再レンダーされても（例: 現在時刻の1分ごとの tick）、
  // 手動で書き込んだ el.style.height をこの effect 外の再レンダーで
  // 巻き戻されないようにするためのガード。top/left/width は自前で
  // 直接書き換えることがないので毎回 props の値をそのまま使ってよい。
  const isResizing = dragRef.current?.kind === "resize";
  // カスケード表示(フェーズ5): leftPct/widthPct は「日列の左右インセットを除いた
  // 使用可能幅」に対する % (WeekGrid 側で計算済み)。px のインセットと % を
  // calc() で組み合わせ、予定が日の仕切り線に密着しないようにする
  // Busy/予定あり は中身の無い「ブロックされた時間」。実予定と区別できるよう
  // 斜線ハッチの控えめな見た目にする(.event--busy)が、そのカレンダーの色を
  // 使ったハッチにする(2026-07-20 ユーザー決定)。左ボーダーとハッチの斜線の
  // 両方に使う色を --busy-color として CSS へ渡し、.event--busy 側の
  // repeating-linear-gradient がそれを参照する。色が解決できない/不正なら
  // resolveBusyColor が従来のグレーにフォールバックする。
  const isBusy = isBusyPlaceholder(occurrence.title);
  const busyColor = isBusy ? resolveBusyColor(occurrence, calendarLookup) : undefined;
  // 表示色バグ修正 (2026-07-20): 生の occurrence.color を直接使わず、常に
  // resolveDisplayColor 経由で解決する。hasCustomColor が無ければ calendarLookup の
  // カレンダー色を優先するため、初回同期時に defaultColor が未定義だった occurrence でも
  // パネルの色と一致する(再同期不要)。イベント個別色 (hasCustomColor) は尊重される。
  const displayColor = isBusy ? undefined : resolveDisplayColor(occurrence, calendarLookup);
  // 参加ステータス表示 (RSVP、2026-07-22)。Busy プレースホルダには適用しない(要件)。
  // 不在(OOO)は DayColumn 側で専用レールへ振り分け済みでそもそもこのコンポーネントに
  // 来ないため、ここでの排他判定は不要。attendees の無い自分の予定 (responseStatus
  // undefined) は accepted と同じ扱い(通常表示のまま何も変えない)。
  //   - needsAction: 塗りなし・カレンダー色の実線枠(下の style 計算で反映)
  //   - tentative: 半透明(event--rsvp-tentative、CSS 側で opacity)
  //   - declined: タイトル打ち消し線 + 全体を淡色に(event--rsvp-declined)
  // 勤務場所 (workingLocation) は WeekGrid 側で packColumns の入力から除外され、専用の
  // 帯レール(layout/workingLocationRail.ts、WorkingLocationRailBand.tsx)へ振り分けられる
  // ため、このコンポーネントに occurrence.isWorkingLocation===true が渡ってくることはない
  // (2026-07-22 帯化 ―― さらに前のコミットにあった「稀に時刻付きで届いた場合の保険」として
  // の opacity 0.5・枠なし表示は、対象が location フィールドの取り違えだったため撤去した)。
  const responseStatus = isBusy ? undefined : occurrence.responseStatus;
  const isNeedsAction = responseStatus === "needsAction";
  const isTentative = responseStatus === "tentative";
  const isDeclined = responseStatus === "declined";
  // オンライン/現地の手段表示 (2026-07-22)。Google API は「自分がオンライン/現地のどちらで
  // 参加するか」という attendee 単位の情報を公開していないため、イベント側の手段の有無
  // (会議リンク・location)で近似する(ユーザー決定、詳細は apps/sync の deriveHasConference・
  // packages/shared/src/protocol.ts の GoogleEventDTO.hasConference コメント参照)。
  // Busy プレースホルダには適用しない(中身の無いブロックのため)。isOutOfOffice/
  // isWorkingLocation な occurrence はそもそもこのコンポーネントに来ない(WeekGrid 側で
  // 専用レールへ振り分け済み)ため、ここでの排他判定は不要 ―― 「通常の予定」だけがここに
  // 来る前提でよい。
  // 会議 URL 判定 (2026-07-25): 会議 URL の入り方は2通りある ――
  //   - Slack ハドル: conferenceData/hangoutLink を持たず location に huddle URL が入る
  //     (hasConference は立たない)
  //   - Meet / カレンダーのアドオン経由の Zoom・Teams: hangoutLink / conferenceData 側に入り、
  //     location は空か会議室名(サーバーが conferenceUrl として持ち出す、2026-07-25)
  // どちらも resolveMeetingUrl で1本に解決してからプロバイダを判定する(layout/meetingLinks.ts)。
  // 判定できたら「場所」ではなく「会議」として扱い、生 URL の代わりにプロバイダのアイコン +
  // 短いラベルを出す。
  const meetingUrl = !isBusy
    ? resolveMeetingUrl(occurrence.conferenceUrl, occurrence.location)
    : undefined;
  const meetingProvider = detectMeetingProvider(meetingUrl);
  // プロバイダが判明しているときは専用アイコン(Meet/Zoom/Teams/Slack)の方が具体的なので、
  // 汎用のビデオアイコンは出さない(同じ意味のアイコンが2つ並ぶのを防ぐ、2026-07-25)。
  const showVideoIcon = !isBusy && occurrence.hasConference === true && meetingProvider === null;
  // 場所テキスト行 (2026-07-22、ユーザー追加要望): 非コンパクト表示のときだけ、タイトルの
  // 下に PlaceIcon + location の1行を追加で出す(Google カレンダーの予定カードと同じ体裁)。
  // コンパクト表示 (isCompact、40分未満の短い予定) は時刻+タイトルの1行しか横幅・縦幅の
  // 余裕が無いため、この行は出さない(要件どおり)。カード自体の overflow:hidden により、
  // 高さが足りない予定(コンパクト閾値は超えるがそれでも短い等)ではこの行が自然に
  // クリップされる ―― 個別の高さ判定は行わず、CSS のあふれ処理に任せる(要件で許容された
  // 簡易実装)。
  // Meet 等は location が空(会議 URL は conferenceUrl 側)でも「会議」の行を出したいので、
  // location の有無だけでなく meetingProvider の有無も条件に含める(2026-07-25)。
  const hasLocationText =
    !isBusy && !isCompact && (!!occurrence.location || meetingProvider !== null);
  // 場所テキスト行に出す文字列。会議 URL のときは長い生 URL ではなくラベル
  // (例: 「Slack ハドル」)にする ―― カード上は表示だけに留め、実際に参加できるリンクは
  // 詳細ポップオーバー (EventDetailCard) 側に置く(カード全体のクリック=詳細を開く、
  // という既存仕様を壊さないため。.event-location は CSS で pointer-events:none)。
  const locationLabel = meetingProvider
    ? meetingProviderLabel(meetingProvider)
    : occurrence.location;
  // ヘッダー行の小さな PlaceIcon は、場所テキスト行が出るなら冗長なので省く(場所は
  // テキスト行側で示すため)。コンパクト表示のときは場所テキスト行が無い代わりに、
  // 従来どおりこのヘッダー(1行)の小アイコンで場所の有無だけを示す。
  // 会議 URL のときは PlaceIcon(場所)ではなくプロバイダアイコン(会議)を出す。
  const showHeaderMeetingIcon = meetingProvider !== null && !hasLocationText;
  const showHeaderPlaceIcon =
    !isBusy && !!occurrence.location && meetingProvider === null && !hasLocationText;
  const hasMeansIcons = showVideoIcon || showHeaderPlaceIcon || showHeaderMeetingIcon;
  // 左インセットだけ日ごとに可変(不在レール矩形化、2026-07-22)。右は常に DAY_COLUMN_INSET_PX。
  const leftInsetPx = leftInsetPxProp ?? DAY_COLUMN_INSET_PX;
  const usableWidthExpr = `(100% - ${leftInsetPx}px - ${DAY_COLUMN_INSET_PX}px)`;

  // 同一予定の集約(フェーズ5〜6): 2件以上の複製がある場合、左端に所属カレンダー
  // ぶんの色ストライプを並べて「複数カレンダーにまたがっている」ことを一目で
  // 分かるようにする(単一メンバー時は従来通り単色の左ボーダーのまま)。
  const stripeColors =
    groupMembers.length > 1 ? buildCalendarStripeColors(groupMembers, calendarLookup) : [];
  const hasStripes = stripeColors.length > 0;
  const STRIPE_WIDTH_PX = 3;
  const STRIPE_CONTENT_GAP_PX = 4; // .event の既定 padding-left (4px) と揃える

  const style: CSSProperties = {
    top,
    left: `calc(${leftInsetPx}px + ${usableWidthExpr} * ${leftPct / 100})`,
    width: `calc(${usableWidthExpr} * ${widthPct / 100})`,
    zIndex: stackIndex + 1,
    // カスケード重ね (2026-07-20) 以降、背景は不透明必須: 半透明 (`${color}26`) だと
    // 重なった下のカードの文字が透けて読めなくなる。色味は同等のまま白と混合して不透明化。
    // Busy は背景を独自指定せず、色付きハッチ(CSS 側 .event--busy + --busy-color)に任せる。
    // needsAction (RSVP 未返信、2026-07-22) は「輪郭のみ・塗りなし」を要件どおり表現するため、
    // 左ボーダーのみの通常カードとは別に全周 1.5px のカレンダー色枠に切り替える。
    ...(isBusy
      ? ({ borderLeftColor: busyColor, "--busy-color": busyColor } as CSSProperties)
      : isNeedsAction
        ? ({
            backgroundColor: "transparent",
            border: `1.5px solid ${displayColor}`,
          } as CSSProperties)
        : {
            backgroundColor: `color-mix(in srgb, ${displayColor} 15%, white)`,
            borderLeftColor: displayColor,
          }),
    // ストライプ表示時は単色の左ボーダーを消し、そのぶんテキストの開始位置を右へ押し出す
    ...(hasStripes
      ? {
          borderLeft: "none",
          paddingLeft: `${stripeColors.length * STRIPE_WIDTH_PX + STRIPE_CONTENT_GAP_PX}px`,
        }
      : {}),
  };
  if (!isResizing) {
    style.height = height;
  }

  return (
    <>
      <div
        ref={elRef}
        className={[
          "event",
          isCompact ? "event--compact" : "",
          isBusy ? "event--busy" : "",
          isTentative ? "event--rsvp-tentative" : "",
          isDeclined ? "event--rsvp-declined" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={style}
        onPointerDown={handlePointerDownMove}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={tooltip.onPointerEnter}
        onPointerLeave={tooltip.onPointerLeave}
      >
        {hasStripes && (
          // 集約カードの「複数カレンダーにまたがっている」印。ドラッグ/クリックの
          // 判定を奪わないよう pointer-events:none(CSS 側)にしてある
          <span className="event-cal-stripes" aria-hidden="true">
            {stripeColors.map((c, i) => (
              <span key={i} className="event-cal-stripe" style={{ background: c }} />
            ))}
          </span>
        )}
        {occurrence.isMirror === true && (
          // 自動生成 mirror の印(第5段階): カレンダーブロック機能が他カレンダーの予定から
          // 自動で作った「予定あり」だと分かるよう、控えめなラベルを隅に出す。既存の
          // Busy ハッチ・バッジの邪魔をしないよう pointer-events:none、朱は使わず既存の
          // 薄墨トーン(#8a8478 系)に揃える(ユーザー指示 2026-07-20)。
          <span className="event-mirror-tag" aria-hidden="true">
            自動
          </span>
        )}
        {!isBusy &&
          blockedByBusyColors &&
          blockedByBusyColors.length > 0 && (
            // 「予定あり」バッジ(2026-07-20 ユーザー決定): Busy は最背面のまま動かさず、
            // Busy の時間帯と重なる実予定側にバッジを出して「他の予定に隠れている Busy がある」
            // ことを示す。ブロック元 Busy のカレンダー色を斜線に反映(複数色は横に並べる)。
            // ドラッグ/クリックを奪わないよう pointer-events:none(CSS 側)
            <span className="event-busy-badge" aria-hidden="true">
              {blockedByBusyColors.map((c, i) => (
                <span
                  key={i}
                  className="event-busy-badge-stripe"
                  style={{
                    backgroundImage: `repeating-linear-gradient(-45deg, transparent, transparent 2px, ${c} 2px, ${c} 4px)`,
                  }}
                />
              ))}
            </span>
          )}
        {isCompact ? (
          <span className="event-line">
            <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
            {hasMeansIcons && (
              // オンライン/現地の手段アイコン(2026-07-22)。ドラッグ/クリックの判定を
              // 奪わないよう pointer-events:none(CSS 側、.event-means-icons)
              <span className="event-means-icons" aria-hidden="true">
                {showVideoIcon && <VideoIcon width={10} height={10} />}
                {showHeaderMeetingIcon && (
                  <MeetingProviderIcon provider={meetingProvider} width={10} height={10} />
                )}
                {showHeaderPlaceIcon && <PlaceIcon width={10} height={10} />}
              </span>
            )}
            <span className="event-title">{occurrence.title}</span>
          </span>
        ) : (
          <>
            <span className="event-header-row">
              <span className="event-time">{formatTime(occurrence.startMs, timeZone)}</span>
              {hasMeansIcons && (
                <span className="event-means-icons" aria-hidden="true">
                  {showVideoIcon && <VideoIcon width={10} height={10} />}
                  {showHeaderMeetingIcon && (
                    <MeetingProviderIcon provider={meetingProvider} width={10} height={10} />
                  )}
                  {showHeaderPlaceIcon && <PlaceIcon width={10} height={10} />}
                </span>
              )}
            </span>
            <span className="event-title">{occurrence.title}</span>
            {hasLocationText && (
              // 場所テキスト行(2026-07-22)。event-mirror-tag/event-busy-badge と違い
              // ここは意味のある実データ(場所名)なので aria-hidden は付けない(スクリーン
              // リーダーにもタイトルと同様に読まれてよい)。PlaceIcon 自体は装飾なので
              // icons.tsx 側で常に aria-hidden 済み。ドラッグ/クリックの判定を奪わないよう
              // pointer-events:none は CSS 側 (.event-location) で持たせる。1行省略は
              // テキスト部分(.event-location-text)側で行う(アイコンは縮めたくないため
              // flex: 0 0 auto)。
              // 会議 URL のとき (2026-07-25) はピン+生 URL ではなく、プロバイダアイコン+
              // ラベル(例: Slack マーク + 「Slack ハドル」)にする ―― 生 URL は長くて
              // 1行に収まらず読めないため。参加リンクは詳細ポップオーバー側に置く。
              //
              // 折り返し表示 (2026-07-25、ユーザー要望): 場所は1行省略ではなく「カードの
              // 高さに収まる行数だけ折り返す」。行数はカード高さ(=予定の長さ × 現在のズーム)
              // から算出し(locationLineClamp、gridMetrics.ts)、CSS 変数 --location-lines として
              // line-clamp に渡す ―― 時間軸ズームで縦に広げたぶん読める行数が増える。
              // リサイズドラッグ中は height を DOM へ直接書いているためこの行数は確定時まで
              // 更新されないが、はみ出しはカードの overflow: hidden が吸収する。
              <span
                className="event-location"
                style={{ "--location-lines": locationLineClamp(height) } as CSSProperties}
              >
                {meetingProvider !== null ? (
                  <MeetingProviderIcon provider={meetingProvider} width={10} height={10} />
                ) : (
                  <PlaceIcon width={10} height={10} />
                )}
                <span className="event-location-text">{locationLabel}</span>
              </span>
            )}
          </>
        )}
        <div className="event-resize-handle" onPointerDown={handlePointerDownResize} />
      </div>
      {detailPos &&
        createPortal(
          <EventDetailCard
            ref={detailCardRef}
            subject={occurrence}
            dateTimeLabel={formatDetailDateTime(occurrence.startMs, occurrence.endMs, timeZone)}
            position={detailPos}
            groupMembers={groupMembers}
            calendarLookup={calendarLookup}
            onClose={() => setDetailPos(null)}
            onDelete={occurrence.source === "google" ? () => onDelete(occurrence) : undefined}
            timeZone={timeZone}
            editDraft={
              isEditableEventSubject(occurrence) ? draftFromOccurrence(occurrence) : undefined
            }
            canToggleAllDay={occurrence.seriesId === null}
            onSaveEdit={(draft) => onSaveEdit(occurrence, draft)}
            rsvpStatus={occurrence.responseStatus}
            onRsvp={(status) => onRsvp(occurrence, status)}
          />,
          document.body,
        )}
    </>
  );
}
