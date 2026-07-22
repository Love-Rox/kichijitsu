import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent, Ref } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { Occurrence, OccurrenceLink } from "../model/types";
import { snapEndMs, snapStartMs } from "../layout/snap";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import {
  clampPopoverPosition,
  fillTooltipContent,
  getSharedTooltipEl,
  positionTooltip,
  stripHtmlToPlainText,
} from "./eventPopoverShared";
import {
  DAY_COLUMN_INSET_PX,
  formatDetailDateTime,
  formatRange,
  formatTime,
  isBusyPlaceholder,
  minutesToPx,
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
import { RsvpNotAttendeeError } from "../sync/eventRsvp";
import { PlaceIcon, VideoIcon } from "./icons";
import { EventEditForm } from "./EventEditForm";

/** カレンダー名/色。App.tsx が calendarsByAccount から `${accountId}:${calendarId}` キーで作る */
export interface CalendarInfo {
  summary: string;
  backgroundColor?: string;
}

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
const HOVER_DELAY_MS = 400;

/**
 * 週7列グリッドの左端からのドラッグ着地列を [0,6] に収めるためだけの、
 * このファイル内限定のクランプ(共有版は eventPopoverShared.ts の
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
  const elRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const hoverTimeoutRef = useRef<number | undefined>(undefined);
  const tooltipShownRef = useRef(false);
  const detailCardRef = useRef<HTMLDivElement>(null);
  // クリック(≒詳細ポップオーバーを開く座標)。null の間は非表示
  const [detailPos, setDetailPos] = useState<{ x: number; y: number } | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleKeyDown = useRef((e: KeyboardEvent) => {
    if (e.key === "Escape") cancelDrag();
  }).current;

  function createBadge(): HTMLDivElement {
    const badge = document.createElement("div");
    badge.className = "drag-badge";
    return badge;
  }

  function hideTooltip() {
    if (hoverTimeoutRef.current !== undefined) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = undefined;
    }
    if (tooltipShownRef.current) {
      getSharedTooltipEl().style.display = "none";
      tooltipShownRef.current = false;
    }
  }

  function showTooltip(clientX: number, clientY: number) {
    const el = getSharedTooltipEl();
    fillTooltipContent(
      el,
      occurrence.title,
      formatRange(occurrence.startMs, occurrence.endMs, timeZone),
      occurrence.location,
    );
    el.style.display = "block";
    positionTooltip(el, clientX, clientY);
    tooltipShownRef.current = true;
  }

  function handlePointerEnter(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current) return;
    const clientX = e.clientX;
    const clientY = e.clientY;
    hoverTimeoutRef.current = window.setTimeout(() => {
      hoverTimeoutRef.current = undefined;
      if (dragRef.current) return; // タイマー発火までにドラッグが始まっていたら出さない
      showTooltip(clientX, clientY);
    }, HOVER_DELAY_MS);
  }

  function handlePointerLeave() {
    hideTooltip();
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
  // ホバー中のツールチップ(共有 DOM ノード)もこのブロック宛のままにしない
  useEffect(() => {
    return () => {
      hideTooltip();
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
    hideTooltip(); // 操作を始めたらツールチップは即座に消す(ドラッグ中は表示しない)
    el.setPointerCapture(e.pointerId);
    const gridRect = gridEl.getBoundingClientRect();
    // モバイル対応フェーズ2: 列数は固定7ではなく weekDayStarts.length (=dayCount) に従う
    // (週ビュー=7、day3/day1 ビューではそれぞれ3/1)
    const columnWidthPx = gridRect.width / weekDayStarts.length;
    const grabOffsetMinutes =
      kind === "move" ? pxToMinutes(e.clientY - gridRect.top) - pxToMinutes(top) : 0;

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
      if (!ds && tooltipShownRef.current) {
        positionTooltip(getSharedTooltipEl(), e.clientX, e.clientY);
      }
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
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop);
      const rawStartMinutes = pointerMinutes - ds.grabOffsetMinutes;
      const targetDayStartMs = ds.weekDayStarts[targetIndex];
      const rawStartMs = targetDayStartMs + rawStartMinutes * 60_000;
      const snappedStart = snapStartMs(rawStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      });
      const durationMs = ds.originalEndMs - ds.originalStartMs;
      const snappedEnd = snappedStart + durationMs;

      const newTopPx = minutesToPx((snappedStart - targetDayStartMs) / 60_000);
      const dxPx = (targetIndex - dayIndex) * ds.columnWidthPx;
      const dyPx = newTopPx - ds.originalTopPx;
      el.style.transform = `translate(${dxPx}px, ${dyPx}px)`;

      ds.pendingStartMs = snappedStart;
      ds.pendingEndMs = snappedEnd;
      ds.badgeEl.textContent = formatRange(snappedStart, snappedEnd, timeZone);
    } else {
      const pointerMinutes = pxToMinutes(e.clientY - ds.gridTop);
      const rawEndMs = ds.dayStartMs + pointerMinutes * 60_000;
      const snappedEnd = snapEndMs(rawEndMs, ds.originalStartMs, {
        originalStartMs: ds.originalStartMs,
        disableSnap: e.altKey,
      });
      const newHeightPx = Math.max(
        minutesToPx((snappedEnd - ds.dayStartMs) / 60_000) - ds.originalTopPx,
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
      hideTooltip();
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
  const showVideoIcon = !isBusy && occurrence.hasConference === true;
  // 場所テキスト行 (2026-07-22、ユーザー追加要望): 非コンパクト表示のときだけ、タイトルの
  // 下に PlaceIcon + location の1行を追加で出す(Google カレンダーの予定カードと同じ体裁)。
  // コンパクト表示 (isCompact、40分未満の短い予定) は時刻+タイトルの1行しか横幅・縦幅の
  // 余裕が無いため、この行は出さない(要件どおり)。カード自体の overflow:hidden により、
  // 高さが足りない予定(コンパクト閾値は超えるがそれでも短い等)ではこの行が自然に
  // クリップされる ―― 個別の高さ判定は行わず、CSS のあふれ処理に任せる(要件で許容された
  // 簡易実装)。
  const hasLocationText = !isBusy && !isCompact && !!occurrence.location;
  // ヘッダー行の小さな PlaceIcon は、場所テキスト行が出るなら冗長なので省く(場所は
  // テキスト行側で示すため)。コンパクト表示のときは場所テキスト行が無い代わりに、
  // 従来どおりこのヘッダー(1行)の小アイコンで場所の有無だけを示す。
  const showHeaderPlaceIcon = !isBusy && !!occurrence.location && !hasLocationText;
  const hasMeansIcons = showVideoIcon || showHeaderPlaceIcon;
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
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
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
              <span className="event-location">
                <PlaceIcon width={10} height={10} />
                <span className="event-location-text">{occurrence.location}</span>
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
 * createPortal している。
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
  const memberCalendars = groupMembers
    .map((m) => {
      const info =
        m.accountId && m.calendarId
          ? calendarLookup.get(`${m.accountId}:${m.calendarId}`)
          : undefined;
      return info
        ? { key: m.id, color: info.backgroundColor ?? "#9ca3af", summary: info.summary }
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
         */}
        {subject.hasConference === true && (
          <div className="event-detail-conference">
            <VideoIcon width={12} height={12} />
            オンライン会議あり
          </div>
        )}
        {subject.location && (
          <div className="event-detail-location">
            <PlaceIcon width={12} height={12} />
            場所: {subject.location}
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
