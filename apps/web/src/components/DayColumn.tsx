import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { Occurrence, PlannedBlock } from "../model/types";
import {
  buildCreateDraft,
  findWriteTarget,
  writeTargetKey,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "../sync/eventCreate";
import type { EventEditDraft } from "../sync/eventEdit";
import type { GitHubActivityCluster } from "../sync/mapActivity";
import { ciMarkerStatusClass, ciStatusLabel, type GitHubCiCluster } from "../sync/mapCiRuns";
import {
  computeDropStartMs,
  DEFAULT_PLANNED_DURATION_MS,
  parseDroppedWorkItem,
  WORKITEM_DND_MIME,
  type DroppedWorkItem,
} from "../sync/planned";
import { packColumns } from "../layout/packColumns";
import { clusterOverflowSuffix } from "../layout/clusterByTopPx";
import { packRailBandColumns } from "../layout/railStack";
import type { OccurrenceGroup } from "../layout/groupDuplicates";
import type { OooRailItem } from "../layout/oooRail";
import type { WorkingLocationRailItem } from "../layout/workingLocationRail";
import {
  busyOverlapColors,
  cascadeStepFrac,
  COMPACT_THRESHOLD_PX,
  dayColumnLeftInsetPx,
  formatTime,
  isBusyPlaceholder,
  minutesToPx,
  msRangeToHeightPx,
  msToTopPx,
  pxToMinutes,
  RAIL_BAND_WIDTH_PX,
  RAIL_MIN_BAND_HEIGHT_PX,
} from "../layout/gridMetrics";
import { resolveDisplayColor } from "../layout/eventColors";
import { snapStartMs, SNAP_MS } from "../layout/snap";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { useHourHeight } from "../hooks/useHourHeight";
import { calendarKey } from "../layout/keys";
import { EventBlock, type CalendarInfo } from "./EventBlock";
import { clampPopoverPosition } from "./eventPopoverShared";
import { EventEditForm } from "./EventEditForm";
import { RailBand } from "./RailBand";
import { PlannedBlockCard } from "./PlannedBlock";
import "./DayColumn.css";

/** 空き領域クリックで作る新規予定のデフォルトの長さ(縦ドラッグせずクリックだけで確定した場合) */
const DEFAULT_CREATE_DURATION_MS = 60 * 60_000;
/** これ未満の移動量はドラッグとみなさず「クリック」扱いにする(EventBlock の CLICK_THRESHOLD_PX と同じ考え方) */
const CREATE_CLICK_THRESHOLD_PX = 4;
/**
 * モバイル対応フェーズ2(docs/multiplatform.md): longPressCreate が true のとき、
 * 空き領域を押してから作成ドラッグを開始するまでの遅延。この間に一定量動いたら
 * 「スクロールしようとした」とみなして作成をキャンセルする(LONG_PRESS_MOVE_CANCEL_PX)。
 */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_CANCEL_PX = 10;
/**
 * 「詳細を入力」で開く作成フォームのポップオーバーの想定サイズ (2026-07-29 全項目入力)。
 * EventBlock.css の .event-detail-popover--editing の width と
 * .event-detail-popover--creating の max-height に合わせてある
 * ―― 位置のクランプ (clampPopoverPosition) がこのサイズを前提に画面内へ収めるので、
 * CSS とずれるとスマホ幅で画面外へはみ出す。
 */
const CREATE_POPOVER_SIZE_PX = { width: 320, maxHeight: 520 };

interface CreateDragState {
  pointerId: number;
  moved: boolean;
  startClientY: number;
  /** 日列 DOM の getBoundingClientRect().top (px, viewport 座標) */
  columnTop: number;
  /** ドラッグ開始点をスナップした epoch ms (アンカー、上にも下にも伸ばせる) */
  anchorMs: number;
  pendingStartMs: number;
  pendingEndMs: number;
  ghostEl: HTMLDivElement;
}

/** 長押し判定待ちの状態(longPressCreate モードのみ使う)。タイマー発火前に一定量動くとキャンセルする */
interface LongPressPendingState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  columnEl: HTMLDivElement;
}

/**
 * pointerup で確定した、タイトル入力待ちの新規予定の時間帯。
 * anchorX/anchorY は指を離した位置 (viewport 座標) で、「詳細を入力」で開くフォームの
 * ポップオーバー位置に使う (2026-07-29 全項目入力、EventBlock の詳細ポップオーバーと同じ流儀)。
 */
interface DraftRange {
  startMs: number;
  endMs: number;
  anchorX: number;
  anchorY: number;
}

interface DayColumnProps {
  dayIndex: number;
  dayStartMs: number;
  dayEndMs: number;
  isToday: boolean;
  nowMs: number;
  positioned: ReturnType<typeof packColumns<OccurrenceGroup>>;
  timeZone: string;
  weekDayStarts: readonly number[];
  /** kind (フェーズ2、2026-07-22): EventBlockProps.onCommit と同じ("move"/"resize") */
  onCommit: (updated: Occurrence, kind: "move" | "resize") => void;
  onDelete: (occurrence: Occurrence) => void;
  /** 詳細ポップオーバーの編集フォーム「保存」から呼ばれる(フェーズ2、2026-07-22) */
  onSaveEdit: (occurrence: Occurrence, draft: EventEditDraft) => Promise<void>;
  /** 詳細ポップオーバーの RSVP ボタンから呼ばれる(フェーズ2、2026-07-22) */
  onRsvp: (occurrence: Occurrence, status: RsvpResponseStatus) => Promise<void>;
  calendarLookup: Map<string, CalendarInfo>;
  /** 新規予定の既定の書き込み先。null なら(未連携・カレンダー未選択)空き領域クリックでの作成を無効化する */
  writeTarget: WriteTargetCandidate | null;
  /**
   * 書き込み先として選べる全カレンダー(表示中のもの、2026-07-29 全項目入力)。
   * 詳細フォームの「カレンダー」欄の選択肢になる。2件以上あるときだけ欄が出る
   * (EventEditForm 側の判定)。速い経路 (ドラッグ→タイトル→Enter) は常に writeTarget を使う。
   */
  writeTargets: readonly WriteTargetCandidate[];
  /** 作成の確定。draft は速い経路(タイトルのみ)も詳細フォーム(全項目)も同じ形 */
  onCreateEvent: (draft: EventCreateDraft, target: WriteTargetCandidate) => void;
  /**
   * モバイル対応フェーズ2: true のとき、空き領域からの新規作成トリガーを即時クリックではなく
   * 長押し(LONG_PRESS_MS)起点にする(タッチのネイティブ縦スクロールと競合しないようにするため)。
   * 省略時は false(既存のデスクトップ向け即時クリック挙動)
   */
  longPressCreate?: boolean;
  /**
   * GitHub 実績オーバーレイ(docs/github-integration.md フェーズ③Part B、sync/mapActivity.ts)。
   * この日ぶんの commit クラスタ配列(空なら何も描画しない)。日列右端の
   * DAY_COLUMN_INSET_PX ぶんの細い「レール」に、クラスタの代表位置(topPx)へ小さな点として
   * 描画する。このガターは EventBlock のカスケード表示がどの段でも侵入しない領域なので、
   * 予定カードと絶対に重ならない(gridMetrics.ts の DAY_COLUMN_INSET_PX コメント参照)。
   */
  activityClusters: GitHubActivityCluster[];
  /**
   * GitHub CI/Actions 実行オーバーレイ(docs/github-integration.md フェーズ④b「CI/Actions
   * 実行をタイムラインに薄く重ねる」、sync/mapCiRuns.ts)。この日ぶんの workflow run
   * クラスタ配列(空なら何も描画しない)。activityClusters(commit 実績、日列右端の
   * `.day-activity-rail`)とは分離した、日列左端の `.day-ci-rail` に描画する — 同じ
   * DAY_COLUMN_INSET_PX ぶんの左右ガターを使うので、こちらも予定カードと絶対に重ならない。
   */
  ciClusters: GitHubCiCluster[];
  /**
   * 不在 (Out of Office) レール(不在レール表示、2026-07-22)。この日ぶんの不在アイテム
   * (WeekGrid 側で eventType==='outOfOffice' な occurrence/終日 occurrence を packColumns の
   * 入力・AllDayBar のチップから除外して集めたもの、layout/oooRail.ts 参照)。
   * activityClusters/ciClusters と同じ左端 DAY_COLUMN_INSET_PX ぶんのガター(`.day-rail`)に
   * 描画するが、CI(`.day-ci-rail`)と同じ左側を共有する — CI は既定 OFF なので通常は
   * 空いている。同時表示になった場合の重なり順は CSS 側 (WeekGrid.css) の z-index で
   * 「不在ライン/× が下、CI マーカーが上」に固定してある。
   *
   * 2026-07-22 横ずれ解消リファクタ: 時刻の不在(startMs を持つ subject)と終日の不在
   * (全高ライン、subject が startDate/endDate のみ)が同じ配列に混在している。DayColumn 側で
   * この2つを再度分け、終日ぶんは従来どおり列パッキング対象外の全高ラインとして描画し、
   * 時刻ぶんだけを勤務場所と合わせて列パッキング(layout/railStack.ts)にかける。
   */
  oooItems: OooRailItem[];
  /**
   * 勤務場所(workingLocation)レール。この日ぶんを「重なりの無い区間の列」へ畳んだ結果
   * (2026-07-29「1日の区間として描く」、layout/workingLocationSegments.ts の
   * foldWorkingLocationDay)。OOO と同じく packColumns の入力からは除外する ―― カードとしては
   * 描画せず、このレールの帯だけで表す。
   *
   * 区間の中身は「終日の勤務場所 = その日の既定の場所(地)」と「時刻付きの勤務場所 = その範囲の
   * 上書き」を畳んだもので、subject は時刻予定・終日予定のどちらもありうる(RailBand.tsx が
   * subject の形で表示を分岐する)。ただし終日ぶんが混ざるのは **その日に時刻付きが1件以上
   * ある場合だけ** ―― 時刻付きが無い日の終日ぶんは従来どおり終日レーンのチップとして出る
   * (振り分けは WeekGrid 側の splitWorkingLocationAllDayGroups、詳細は
   * layout/workingLocationRail.ts 冒頭コメント)。
   *
   * `.day-rail`(OOO の時刻ぶんと同じ x=0 起点の列を共有する。時間が重なる帯どうしだけ
   * layout/railStack.ts の列パッキングで列を分けて横に並べる。2026-07-22 横ずれ解消
   * リファクタ以前は「OOO がある日は常にバー1本ぶん内側へずらす」固定オフセットだったが、
   * 同時刻(特に長さ0)の帯が横にずれて見える不具合があったため撤去した)に描画する。
   * 区間どうしは定義上重ならないので、勤務場所だけの日は必ず1列に収まる。
   */
  workingLocationItems: WorkingLocationRailItem[];
  /**
   * 予定タイムブロック(docs/github-integration.md「時間計測」増分1)。この日ぶんの
   * PlannedBlock 配列(WeekGrid 側で [dayStartMs, dayEndMs) に絞り込み済み)。
   */
  plannedBlocks: PlannedBlock[];
  /**
   * 作業キュー(GitHubPane、旧 WorkQueueDrawer)からこの列へドロップされたときに呼ばれる。ローカル専用
   * (Google へは一切書き戻さない) — App.tsx 側は plannedStore.upsert + IndexedDB 書き込みのみ行う。
   */
  onDropWorkItem: (item: DroppedWorkItem, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの移動/リサイズ確定時に呼ばれる(ローカルのみ) */
  onMovePlannedBlock: (id: string, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの削除ボタンから呼ばれる(ローカルのみ) */
  onDeletePlannedBlock: (id: string) => void;
  /**
   * 手動タイマー(docs/github-integration.md「時間計測」増分2)。走行中(endMs===null)な
   * timeEntries の linkedItemId 集合(WeekGrid 側で1回だけ計算済み)。各 PlannedBlockCard の
   * ▶/⏹ 表示切り替えに使う(block.linkedItemId がこの集合に含まれるかだけを見る)。
   */
  runningLinkedItemIds: Set<string>;
  /** ▶ ボタンから呼ばれる(ローカルのみ) */
  onStartTimer: (block: PlannedBlock) => void;
  /** ⏹ ボタンから呼ばれる(ローカルのみ)。対象 item だけを止める(他の並走には触れない) */
  onStopTimer: (linkedItemId: string) => void;
  /**
   * スマホの操作体系(2026-07-26、ユーザー要望): いま選択中のカードのキー(未選択なら null)。
   * 状態の持ち主は WeekGrid ―― ここでは「自分の子カードのどれが選択中か」を比べて渡すだけ。
   * キーは EventBlock(予定)と PlannedBlockCard(予定タイムブロック)の id 空間が混ざらないよう
   * 種別で前置してある(`event:` / `planned:`)。
   */
  selectedCardId: string | null;
  /** カードのタップで選択状態を更新する(WeekGrid の setSelectedCardId) */
  onSelectCard: (cardId: string | null) => void;
}

/**
 * 週グリッドの1日ぶんの列。EventBlock 群の描画に加えて、空き領域の
 * クリック/縦ドラッグによる新規予定作成(フェーズ5)を持つ。
 *
 * 新規作成のトリガー判定: この列の pointerdown ハンドラは `e.target === e.currentTarget`
 * のときだけ反応する(= pointerdown が列の背景そのもので発生した場合のみ)。
 * EventBlock 自身の pointerdown は stopPropagation していないためこの列までバブルするが、
 * その場合 e.target は EventBlock 側の DOM ノードになるので自然に無視される
 * (子要素上のクリックを親側で target 比較だけで弾く、追加の stopPropagation 変更は不要)。
 */
export function DayColumn({
  dayIndex,
  dayStartMs,
  dayEndMs,
  isToday,
  nowMs,
  positioned,
  timeZone,
  weekDayStarts,
  onCommit,
  onDelete,
  onSaveEdit,
  onRsvp,
  calendarLookup,
  writeTarget,
  writeTargets,
  onCreateEvent,
  longPressCreate = false,
  activityClusters,
  ciClusters,
  oooItems,
  workingLocationItems,
  plannedBlocks,
  onDropWorkItem,
  onMovePlannedBlock,
  onDeletePlannedBlock,
  runningLinkedItemIds,
  onStartTimer,
  onStopTimer,
  selectedCardId,
  onSelectCard,
}: DayColumnProps) {
  // 時間軸ズーム(2026-07-25): px⇔分 の変換係数は context 経由で受け取る
  // (状態の持ち主は App.tsx、WeekGrid が Provider を張る。hooks/useHourHeight.tsx 参照)
  const hourHeight = useHourHeight();
  const createDragRef = useRef<CreateDragState | null>(null);
  const longPressPendingRef = useRef<LongPressPendingState | null>(null);
  const longPressTimerRef = useRef<number | undefined>(undefined);
  const [draft, setDraft] = useState<DraftRange | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  /**
   * 「詳細を入力」で全項目フォームへ広げたか (2026-07-29 全項目入力)。true の間は
   * インラインのタイトル入力を畳んで、代わりにポップオーバー (EventEditForm) を出す。
   */
  const [draftDetail, setDraftDetail] = useState(false);
  /** 詳細フォームで選択中の書き込み先 (writeTargetKey)。詳細を開くたびに既定へ戻す */
  const [draftTargetKey, setDraftTargetKey] = useState("");
  const draftRef = useRef<HTMLDivElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const draftDetailRef = useRef<HTMLDivElement>(null);

  const showNowLine = isToday && nowMs >= dayStartMs && nowMs < dayEndMs;
  const nowTop = msToTopPx(nowMs, dayStartMs, hourHeight);

  // カスケードの前面/背面(WeekGrid.tsx から移設、ロジックは変更なし)
  const stackZ = new Map<string, number>();
  positioned
    .map((p) => p.item.primary)
    .sort((a, b) => {
      const busyA = isBusyPlaceholder(a.title) ? 0 : 1;
      const busyB = isBusyPlaceholder(b.title) ? 0 : 1;
      return busyA - busyB || a.startMs - b.startMs || b.endMs - a.endMs;
    })
    .forEach((occ, rank) => stackZ.set(occ.id, rank));

  // 終日 OOO(全高ライン)は列パッキングの対象外(既存のまま、要件変更なし)。
  // oooItems には時刻・終日の両方が混在しているので、subject の形(Occurrence には
  // startMs がある/AllDayOccurrence には無い)で振り分ける。RailBand.tsx の
  // isTimedSubject と同じ構造的ガード。
  const timedOooItems = oooItems.filter((item) => "startMs" in item.subject);
  const allDayOooItems = oooItems.filter((item) => !("startMs" in item.subject));

  // 2026-07-22 横ずれ解消リファクタ: OOO(時刻ぶん)と勤務場所を1本のレール(同じ x=0 起点の
  // 列)に統合し、時間が重なる帯どうしだけを列パッキング(layout/railStack.ts、
  // 勤務場所側は 2026-07-29 以降「1日ぶんを畳んだ区間列」なので、勤務場所どうしは定義上
  // 重ならない。列が増えるのは時刻の OOO と時間帯がぶつかったときだけ。
  // packColumns.ts の貪欲 first-fit を流用)で列分けして横に並べる。重ならない帯(接触含む)は
  // 全て列0(left: 0)に本来の時刻位置のまま乗るので縦に並ぶ。
  // 並び順は OOO → 勤務場所の順で配列を組み立てる ―― 同時刻タイ(例: 終了==開始が同時刻の
  // OOO と勤務場所)になったとき、packRailBandColumns 内の安定ソートにより OOO が列0
  // (カードに一番近い左)に来る(任意だが決めてある。OOO の方が「その場にいない」という
  // より強い情報なので優先して手前寄りに置く)。
  type TimedRailBand =
    | { kind: "ooo"; id: string; startMinutes: number; endMinutes: number; oooItem: OooRailItem }
    | {
        kind: "workloc";
        id: string;
        startMinutes: number;
        endMinutes: number;
        workLocItem: WorkingLocationRailItem;
      };
  const timedRailBands: TimedRailBand[] = [
    ...timedOooItems.map(
      (oooItem): TimedRailBand => ({
        kind: "ooo",
        id: oooItem.id,
        startMinutes: oooItem.startMinutes,
        endMinutes: oooItem.endMinutes,
        oooItem,
      }),
    ),
    ...workingLocationItems.map(
      (workLocItem): TimedRailBand => ({
        kind: "workloc",
        id: workLocItem.id,
        startMinutes: workLocItem.startMinutes,
        endMinutes: workLocItem.endMinutes,
        workLocItem,
      }),
    ),
  ];
  const packedRailBands = packRailBandColumns(
    timedRailBands,
    (b) => b.startMinutes,
    (b) => b.endMinutes,
    hourHeight,
  );
  // その日のレールで実際に必要になった最大列数。終日 OOO しか無い日でも帯1本ぶん(1列)は
  // 確保する(以前の「hasOoo なら16px」という挙動と同じ広さを保つため)。
  const hasAnyRailItem = allDayOooItems.length > 0 || packedRailBands.length > 0;
  const railMaxColumnCount = packedRailBands.reduce((max, p) => Math.max(max, p.columnCount), 0);
  const railColumnCount = hasAnyRailItem ? Math.max(1, railMaxColumnCount) : 0;

  // 左端レールの左インセット一般化: この日のレール列数(railColumnCount、上記)ぶん
  // EventBlock の左インセットを広げて予定カードと重ならないようにする(gridMetrics.ts の
  // dayColumnLeftInsetPx 参照)。レールが無い日(railColumnCount===0)は従来の
  // DAY_COLUMN_INSET_PX のまま。
  const eventLeftInsetPx = dayColumnLeftInsetPx(railColumnCount);

  const busyIntervals = positioned
    .map((p) => p.item.primary)
    .filter((occ) => isBusyPlaceholder(occ.title))
    .map((occ) => ({
      startMs: occ.startMs,
      endMs: occ.endMs,
      color: resolveDisplayColor(occ, calendarLookup),
    }));

  function cancelDraft() {
    setDraft(null);
    setDraftTitle("");
    setDraftDetail(false);
  }

  // 詳細フォームを開いている間はこちらを止める ―― インラインのタイトル入力は
  // アンマウントされていて draftRef.current が null になり、あらゆるクリックが
  // 「外側」判定になってドラフトごと消えてしまうため (フォーム側は自前の
  // バックドロップと Escape で閉じる、下の描画部分参照)
  useCloseOnOutsideOrEscape(draft !== null && !draftDetail, draftRef, cancelDraft);
  // 詳細フォーム側の外側クリック/Escape。EventBlock が詳細ポップオーバーに対して
  // 張っているのと同じ組み合わせ(透明バックドロップ + このフック)
  useCloseOnOutsideOrEscape(draftDetail, draftDetailRef, cancelDraft);

  // アンマウント時に長押しタイマーが残らないようにする(pointerup/cancel を取りこぼした場合の保険)
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== undefined) window.clearTimeout(longPressTimerRef.current);
    };
  }, []);

  /**
   * 実際の作成ドラッグ状態を起こす(desktop の即時クリック起点、longPressCreate の
   * 長押し確定時起点の両方から呼ばれる)。moved=true で呼ぶと ghost をその場で
   * 表示する(長押し確定の瞬間に「作成モードに入った」ことを視覚的に示すため)。
   */
  function beginCreateDrag(
    columnEl: HTMLDivElement,
    pointerId: number,
    clientY: number,
    moved: boolean,
  ) {
    const rect = columnEl.getBoundingClientRect();
    const rawMs = dayStartMs + pxToMinutes(clientY - rect.top, hourHeight) * 60_000;
    const anchorMs = snapStartMs(rawMs, { originalStartMs: rawMs });
    const ghostEl = document.createElement("div");
    ghostEl.className = "day-column-create-ghost";
    const pendingStartMs = anchorMs;
    const pendingEndMs = anchorMs + DEFAULT_CREATE_DURATION_MS;
    createDragRef.current = {
      pointerId,
      moved,
      startClientY: clientY,
      columnTop: rect.top,
      anchorMs,
      pendingStartMs,
      pendingEndMs,
      ghostEl,
    };
    if (moved) {
      columnEl.appendChild(ghostEl);
      ghostEl.style.top = `${msToTopPx(pendingStartMs, dayStartMs, hourHeight)}px`;
      ghostEl.style.height = `${msRangeToHeightPx(pendingStartMs, pendingEndMs, hourHeight)}px`;
    }
  }

  function clearLongPressPending() {
    if (longPressTimerRef.current !== undefined) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    longPressPendingRef.current = null;
  }

  // 注: この列に touch-action: none は付けない(EventBlock の .event と違い列全体が
  // 縦スクロール領域と重なるため、付けるとタッチでのスクロールを壊してしまう)。
  // longPressCreate===false(デスクトップ想定)では本作成ドラッグとタッチのネイティブ
  // スクロールが競合しうるが許容する。longPressCreate===true(狭幅モバイル)では
  // 下記のとおり長押し確定までは何もキャプチャしないことでスクロールを妨げない。
  function handleColumnPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if (e.target !== e.currentTarget) return; // 空き領域の背景そのもの以外(イベントカード等)では発火させない
    if (!writeTarget) return; // 書き込み先カレンダーが無ければ新規作成不可

    if (longPressCreate) {
      // ここでは setPointerCapture も preventDefault も行わない(縦スクロールを妨げない)。
      // LONG_PRESS_MS 後、大きく動いていなければ長押し確定として作成ドラッグを開始する
      // (この時点で setPointerCapture することで、以後の pointermove はスクロールへ流れず
      // このハンドラへ配送される — ブラウザのポインタキャプチャの標準的な使い方)
      const columnEl = e.currentTarget;
      const pointerId = e.pointerId;
      longPressPendingRef.current = {
        pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        columnEl,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        const pending = longPressPendingRef.current;
        longPressTimerRef.current = undefined;
        if (!pending || pending.pointerId !== pointerId) return;
        longPressPendingRef.current = null;
        try {
          pending.columnEl.setPointerCapture(pointerId);
        } catch {
          /* 既にポインタが離れている等は無視 */
        }
        beginCreateDrag(pending.columnEl, pointerId, pending.startClientY, true);
      }, LONG_PRESS_MS);
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    beginCreateDrag(e.currentTarget, e.pointerId, e.clientY, false);
  }

  function handleColumnPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      // 長押し確定前に一定量動いたらスクロール操作とみなし、作成をキャンセルする
      const dx = e.clientX - pending.startClientX;
      const dy = e.clientY - pending.startClientY;
      if (Math.hypot(dx, dy) >= LONG_PRESS_MOVE_CANCEL_PX) {
        clearLongPressPending();
      }
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    if (!ds.moved && Math.abs(e.clientY - ds.startClientY) >= CREATE_CLICK_THRESHOLD_PX) {
      ds.moved = true;
      e.currentTarget.appendChild(ds.ghostEl);
    }
    if (!ds.moved) return;

    const rawMs = dayStartMs + pxToMinutes(e.clientY - ds.columnTop, hourHeight) * 60_000;
    const snapped = snapStartMs(rawMs, { originalStartMs: rawMs });
    const startMs = Math.min(ds.anchorMs, snapped);
    const endMs = Math.max(Math.max(ds.anchorMs, snapped), startMs + SNAP_MS);
    ds.pendingStartMs = startMs;
    ds.pendingEndMs = endMs;

    ds.ghostEl.style.top = `${msToTopPx(startMs, dayStartMs, hourHeight)}px`;
    ds.ghostEl.style.height = `${msRangeToHeightPx(startMs, endMs, hourHeight)}px`;
  }

  function handleColumnPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      // 長押しが確定する前に指を離した = タップ扱い、何も作成しない
      clearLongPressPending();
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みなら無視 */
    }
    ds.ghostEl.remove();
    createDragRef.current = null;

    // moved かどうかに関わらず pendingStartMs/pendingEndMs は常に妥当な範囲を保持している
    // (moved===false のときは初期値 = anchor + デフォルト1時間のまま)
    setDraft({
      startMs: ds.pendingStartMs,
      endMs: ds.pendingEndMs,
      anchorX: e.clientX,
      anchorY: e.clientY,
    });
    setDraftTitle("");
    setDraftDetail(false);
    // 次の描画でマウントされる input に自動でフォーカスする
    requestAnimationFrame(() => draftInputRef.current?.focus());
  }

  function handleColumnPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) {
      clearLongPressPending();
      return;
    }

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    ds.ghostEl.remove();
    createDragRef.current = null;
  }

  /**
   * ポインタキャプチャを他所に奪われたときの後片付け(2026-07-25)。
   *
   * 具体的な経路: 長押しで作成ドラッグに入る(この列が setPointerCapture)→ そのまま横に振ると
   * useSwipeNavigation が横スワイプ確定として .week-grid へ同じ pointerId のキャプチャを移す。
   * すると以後の pointermove/up/cancel はこの列に届かず、createDragRef と ghost 要素が
   * 残置されたままになる(次のタップまで灰色のゴーストが残る/古い pointerId が残る)。
   * lostpointercapture は「キャプチャを失った要素」に発火するので、ここで確実に破棄する。
   *
   * 通常の pointerup 経路では handleColumnPointerUp が先に走って createDragRef を空にしている
   * (仕様上 lostpointercapture は pointerup の直後)ため、ここは何もしない ―― つまり
   * 「奪われた/取りこぼした」ときだけ効く。作成の確定(setDraft)は意図的に行わない:
   * ユーザーの操作は横スワイプへ移っており、そこで入力欄が開くのは誤爆になるため。
   */
  function handleColumnLostPointerCapture(e: ReactPointerEvent<HTMLDivElement>) {
    // lostpointercapture は bubbles: true なので、子孫(EventBlock 等が自前で
    // setPointerCapture したもの)のぶんも上がってくる。キャプチャを取ったのはこの列自身
    // (currentTarget)なので、target が一致するときだけ後片付けする。
    if (e.target !== e.currentTarget) return;
    const pending = longPressPendingRef.current;
    if (pending && pending.pointerId === e.pointerId) clearLongPressPending();

    const ds = createDragRef.current;
    if (!ds || ds.pointerId !== e.pointerId) return;
    ds.ghostEl.remove();
    createDragRef.current = null;
  }

  /**
   * 速い経路の確定 (ドラッグ → タイトル → Enter)。2026-07-29 の全項目入力でも
   * **この経路は一切変えていない** ―― 変わったのは onCreateEvent に渡す形が
   * (startMs, endMs, title) から draft オブジェクトになった点だけ。
   */
  function confirmDraft() {
    const title = draftTitle.trim();
    if (draft && writeTarget && title.length > 0) {
      onCreateEvent(buildCreateDraft(draft.startMs, draft.endMs, title), writeTarget);
    }
    cancelDraft();
  }

  /**
   * 「詳細を入力」(2026-07-29 全項目入力)。インライン入力に打ちかけたタイトルを
   * 引き継いだまま、同じ時間帯を初期値にして全項目フォーム (EventEditForm) を開く。
   * 書き込み先は既定 (writeTarget) を初期選択にする。
   */
  function openDraftDetail() {
    if (!writeTarget) return;
    setDraftTargetKey(writeTargetKey(writeTarget));
    setDraftDetail(true);
  }

  /** 詳細フォームの「作成」。楽観的作成なので await せず、そのまま閉じる(削除導線と同じ流儀) */
  function submitDraftDetail(formDraft: EventEditDraft): Promise<void> {
    const target = findWriteTarget(writeTargets, draftTargetKey) ?? writeTarget;
    if (target) onCreateEvent(formDraft, target);
    cancelDraft();
    return Promise.resolve();
  }

  /** 詳細フォームの「カレンダー」欄の選択肢。表示名は calendarLookup から引く */
  const writeTargetOptions = writeTargets.map((target) => {
    const key = writeTargetKey(target);
    return {
      key,
      label: calendarLookup.get(calendarKey(target.accountId, target.calendarId))?.summary ?? key,
    };
  });

  /**
   * 作業キュー(GitHubPane、旧 WorkQueueDrawer)からのドロップ受け入れ(docs/github-integration.md
   * 「時間計測」増分1)。dragover で e.preventDefault() しないとブラウザが drop を許可しない
   * (HTML5 DnD の標準的な作法)。
   */
  function handleColumnDragOver(e: ReactDragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(WORKITEM_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleColumnDrop(e: ReactDragEvent<HTMLDivElement>) {
    const raw = e.dataTransfer.getData(WORKITEM_DND_MIME);
    const item = parseDroppedWorkItem(raw);
    if (!item) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const startMs = computeDropStartMs(dayStartMs, e.clientY, rect.top, hourHeight);
    onDropWorkItem(item, startMs, startMs + DEFAULT_PLANNED_DURATION_MS);
  }

  // 予定タイムブロックの重なりは既存のカスケード(packColumns)をそのまま流用する
  // (同時刻に複数あれば横ずらしで重ならないようにする、独立レイヤなので Google 予定側の
  // stackZ とは無関係)
  const plannedPositioned = packColumns(
    plannedBlocks,
    (b) => b.startMs,
    (b) => b.endMs,
  );

  return (
    <div
      className={isToday ? "week-grid-day-column is-today" : "week-grid-day-column"}
      onPointerDown={handleColumnPointerDown}
      onPointerMove={handleColumnPointerMove}
      onPointerUp={handleColumnPointerUp}
      onPointerCancel={handleColumnPointerCancel}
      onLostPointerCapture={handleColumnLostPointerCapture}
      onDragOver={handleColumnDragOver}
      onDrop={handleColumnDrop}
    >
      {positioned.map(({ item: group, column, columnCount }) => {
        const occurrence = group.primary;
        const topPx = msToTopPx(occurrence.startMs, dayStartMs, hourHeight);
        const heightPx = msRangeToHeightPx(occurrence.startMs, occurrence.endMs, hourHeight);
        // コンパクト表示の判定は px 基準(時間軸ズーム対応、2026-07-25)。既定ズームでは
        // 従来の「40分未満」と完全に一致する(gridMetrics.ts の COMPACT_THRESHOLD_PX 参照)
        const isCompact = heightPx < COMPACT_THRESHOLD_PX;
        const step = cascadeStepFrac(columnCount);
        const leftPct = column * step * 100;
        const widthPct = 100 - leftPct;
        const stackIndex = stackZ.get(occurrence.id) ?? column;
        const blockedByBusyColors = isBusyPlaceholder(occurrence.title)
          ? []
          : busyOverlapColors(occurrence, busyIntervals);
        // 選択キー(スマホの「タップで選択 → ドラッグで移動」)。PlannedBlock と id 空間が
        // 混ざらないよう種別を前置する
        const cardId = `event:${occurrence.id}`;

        return (
          <EventBlock
            key={occurrence.id}
            occurrence={occurrence}
            groupMembers={group.members}
            stackIndex={stackIndex}
            top={topPx}
            height={heightPx}
            leftPct={leftPct}
            widthPct={widthPct}
            leftInsetPx={eventLeftInsetPx}
            isCompact={isCompact}
            blockedByBusyColors={blockedByBusyColors}
            timeZone={timeZone}
            dayIndex={dayIndex}
            dayStartMs={dayStartMs}
            weekDayStarts={weekDayStarts}
            onCommit={onCommit}
            onDelete={onDelete}
            onSaveEdit={onSaveEdit}
            onRsvp={onRsvp}
            calendarLookup={calendarLookup}
            // 「タップで選択してからドラッグ」は横スワイプ日移動と同じ条件(=スマホ幅)でだけ
            // 有効にする。longPressCreate は isNarrow がそのまま降りてきている値
            selectBeforeDrag={longPressCreate}
            isSelected={selectedCardId === cardId}
            onSelect={() => onSelectCard(cardId)}
          />
        );
      })}
      {plannedPositioned.length > 0 && (
        <div className="day-column-planned-layer">
          {plannedPositioned.map(({ item: block, column, columnCount }) => {
            const step = cascadeStepFrac(columnCount);
            const leftPct = column * step * 100;
            const widthPct = 100 - leftPct;
            const cardId = `planned:${block.id}`;
            return (
              <PlannedBlockCard
                key={block.id}
                block={block}
                dayStartMs={dayStartMs}
                top={msToTopPx(block.startMs, dayStartMs, hourHeight)}
                height={msRangeToHeightPx(block.startMs, block.endMs, hourHeight)}
                leftPct={leftPct}
                widthPct={widthPct}
                timeZone={timeZone}
                onMove={onMovePlannedBlock}
                onDelete={onDeletePlannedBlock}
                isTimerRunning={runningLinkedItemIds.has(block.linkedItemId)}
                onStartTimer={onStartTimer}
                onStopTimer={onStopTimer}
                selectBeforeDrag={longPressCreate}
                isSelected={selectedCardId === cardId}
                onSelect={() => onSelectCard(cardId)}
              />
            );
          })}
        </div>
      )}
      {showNowLine && (
        <div className="now-line" style={{ top: nowTop }}>
          <span className="now-line-dot" />
        </div>
      )}
      {activityClusters.length > 0 && (
        <div className="day-activity-rail">
          {activityClusters.map((cluster) => {
            const latest = cluster.items[cluster.items.length - 1];
            // 「 他N件」の畳み込み表記は CI レール(下記)と共通の純関数
            // (layout/clusterByTopPx.ts の clusterOverflowSuffix)
            const label = `${formatTime(latest.timestampMs, timeZone)} ${latest.title}${clusterOverflowSuffix(cluster.count)}`;
            return (
              <a
                key={`${cluster.topPx}-${latest.id}`}
                href={latest.url}
                target="_blank"
                rel="noopener noreferrer"
                className="day-activity-mark"
                style={{ top: cluster.topPx }}
                title={label}
                aria-label={label}
              >
                {cluster.count > 1 && <span className="day-activity-count">{cluster.count}</span>}
              </a>
            );
          })}
        </div>
      )}
      {hasAnyRailItem && (
        // 統合レール(2026-07-22 横ずれ解消リファクタ): 不在(OOO)と勤務場所を同じ x=0 起点の
        // 1レールにまとめて描画する。以前は .day-ooo-rail/.day-workloc-rail の2つに分かれ、
        // 勤務場所帯を OOO バーぶん内側へ固定オフセットしていたが、それだと同時刻(特に
        // 終了==開始)の帯が横に14pxずれて side-by-side に見えてしまっていた。
        // day-ci-rail と同じ左端ガターを共有する(CI は既定 OFF なので通常は空いている)。
        // DOM 順・CSS 側の z-index (WeekGrid.css の .day-ooo-line/.day-workloc-band) の両方で、
        // 後続の day-ci-rail(CI マーカー)より必ず背面に来るようにしてある。
        // width は railColumnCount(上記、その日実際に必要になった最大列数)ぶん ―― 時間が
        // 重ならない日は1列(12px)のまま、重なる日だけ列数に応じて広がる。
        <div className="day-rail" style={{ width: railColumnCount * RAIL_BAND_WIDTH_PX }}>
          {/* 終日 OOO(全高ライン)は列パッキングの対象外。常に列0・全高のまま独立して描画する
              (既存の挙動を変えない要件)。 */}
          {allDayOooItems.map((item) => (
            <RailBand
              key={item.id}
              variant="ooo"
              item={item}
              top={0}
              height={minutesToPx(item.endMinutes - item.startMinutes, hourHeight)}
              left={0}
              timeZone={timeZone}
              calendarLookup={calendarLookup}
            />
          ))}
          {/* 時刻の OOO・勤務場所は列パッキング結果どおりに top(本来の時刻位置のまま)・
              left(column * RAIL_BAND_WIDTH_PX)で描画する。縦位置は押し下げない ――
              重なる帯だけが横の列で分かれる。 */}
          {packedRailBands.map(({ item: band, column }) => {
            const top = minutesToPx(band.startMinutes, hourHeight);
            const height = Math.max(
              minutesToPx(band.endMinutes - band.startMinutes, hourHeight),
              RAIL_MIN_BAND_HEIGHT_PX,
            );
            const left = column * RAIL_BAND_WIDTH_PX;
            return band.kind === "ooo" ? (
              <RailBand
                key={band.id}
                variant="ooo"
                item={band.oooItem}
                top={top}
                height={height}
                left={left}
                timeZone={timeZone}
                calendarLookup={calendarLookup}
              />
            ) : (
              <RailBand
                key={band.id}
                variant="workingLocation"
                item={band.workLocItem}
                top={top}
                height={height}
                left={left}
                timeZone={timeZone}
                calendarLookup={calendarLookup}
              />
            );
          })}
        </div>
      )}
      {ciClusters.length > 0 && (
        <div className="day-ci-rail">
          {ciClusters.map((cluster) => {
            const latest = cluster.items[cluster.items.length - 1];
            const statusClass = ciMarkerStatusClass(latest);
            const statusLabel = ciStatusLabel(latest);
            const label = `${formatTime(latest.timestampMs, timeZone)} ${latest.name} (${statusLabel})${clusterOverflowSuffix(cluster.count)}`;
            return (
              <a
                key={`${cluster.topPx}-${latest.id}`}
                href={latest.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`day-ci-mark status-${statusClass}`}
                style={{ top: cluster.topPx }}
                title={label}
                aria-label={label}
              >
                {cluster.count > 1 && <span className="day-ci-count">{cluster.count}</span>}
              </a>
            );
          })}
        </div>
      )}
      {draft && !draftDetail && (
        <div
          ref={draftRef}
          className="day-column-create-draft"
          style={{
            top: msToTopPx(draft.startMs, dayStartMs, hourHeight),
            height: msRangeToHeightPx(draft.startMs, draft.endMs, hourHeight),
          }}
        >
          <input
            ref={draftInputRef}
            type="text"
            className="day-column-create-input"
            placeholder="予定のタイトル"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // Shift+Enter は「詳細を入力」と同じ(下のボタンのキーボード版)。
                // 素の Enter は従来どおりその場で作成する速い経路
                if (e.shiftKey) openDraftDetail();
                else confirmDraft();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelDraft();
              }
            }}
          />
          {/*
           * 「詳細を入力」への広げ口 (2026-07-29 全項目入力)。速い経路 (打って Enter) を
           * 邪魔しないよう、入力欄の右端に小さく置くだけにしてある。Tab で辿り着けるし、
           * 入力欄からは Shift+Enter でも開ける (title 属性で案内)。
           */}
          <button
            type="button"
            className="day-column-create-detail-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openDraftDetail}
            title="詳細を入力 (Shift+Enter)"
          >
            詳細
          </button>
        </div>
      )}
      {/*
       * 全項目フォーム (2026-07-29)。予定編集と同じ EventEditForm を、同じ
       * .event-detail-popover--editing の見た目で出す ―― 「編集ではできるのに作成では
       * 入れられない」非対称を消すのが目的なので、フォーム自体は共有する。
       * 位置決め・バックドロップ・portal は EventDetailCard と同じ流儀
       * (.week-grid-days-strip の transform が position:fixed の基準になってしまうため
       * document.body へ portal する)。
       */}
      {draft &&
        draftDetail &&
        writeTarget &&
        createPortal(
          <>
            <div
              className="event-detail-backdrop"
              onPointerDown={(e) => {
                e.stopPropagation();
                cancelDraft();
              }}
            />
            <div
              ref={draftDetailRef}
              className="event-detail-popover event-detail-popover--editing event-detail-popover--creating"
              style={clampPopoverPosition(draft.anchorX, draft.anchorY, CREATE_POPOVER_SIZE_PX)}
              role="dialog"
              aria-label="予定を作成"
            >
              <button
                type="button"
                className="event-detail-close"
                onClick={cancelDraft}
                aria-label="閉じる"
              >
                ×
              </button>
              <div className="event-detail-title">予定を作成</div>
              <EventEditForm
                initialDraft={buildCreateDraft(draft.startMs, draft.endMs, draftTitle)}
                timeZone={timeZone}
                mode="create"
                calendarChoice={{
                  options: writeTargetOptions,
                  value: draftTargetKey,
                  onChange: setDraftTargetKey,
                }}
                // 新規作成は必ず単発予定なので、終日トグルは常に出せる
                // (シリーズ由来の1回分だけが対象外、EventEditForm.tsx のコメント参照)
                canToggleAllDay
                onSave={submitDraftDetail}
                onCancel={cancelDraft}
              />
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
