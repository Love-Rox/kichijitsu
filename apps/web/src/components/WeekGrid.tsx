import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { GitHubActivityDTO, GitHubCiRunDTO, RsvpResponseStatus } from "@kichijitsu/shared";
import type { AllDayOccurrence, Occurrence, PlannedBlock, TaskItem } from "../model/types";
import type { OccurrenceStore } from "../store/occurrenceStore";
import { useOccurrences } from "../store/occurrenceStore";
import type { AllDayStore } from "../store/allDayStore";
import { useAllDayOccurrences } from "../store/allDayStore";
import type { TaskStore } from "../store/taskStore";
import { useTasks } from "../store/taskStore";
import type { GitHubStore } from "../store/githubStore";
import { useGitHubItems } from "../store/githubStore";
import type { PlannedStore } from "../store/plannedStore";
import { usePlannedBlocks } from "../store/plannedStore";
import type { TimeEntryStore } from "../store/timeEntryStore";
import { useRunningTimeEntries } from "../store/timeEntryStore";
import type { WriteTargetCandidate } from "../sync/eventCreate";
import type { EventEditDraft } from "../sync/eventEdit";
import type { DroppedWorkItem } from "../sync/planned";
import { hasOccurrenceTimeChanged } from "../sync/moveConfirm";
import { shouldHideDeclined, type DeclinedVisibilitySettings } from "../sync/declinedVisibility";
import { layoutGitHubDay } from "../sync/mapGitHub";
import { layoutDayActivity } from "../sync/mapActivity";
import { layoutDayCiRuns } from "../sync/mapCiRuns";
import { packColumns } from "../layout/packColumns";
import { packDayBars } from "../layout/packDayBars";
import {
  groupDuplicateAllDayOccurrences,
  groupDuplicateOccurrences,
  type OccurrenceGroup,
} from "../layout/groupDuplicates";
import {
  allDayOooRailItems,
  splitOutOfOfficeAllDayGroups,
  splitOutOfOfficeGroups,
  timedOooRailItems,
  type OooRailItem,
} from "../layout/oooRail";
import {
  splitWorkingLocationGroups,
  timedWorkingLocationRailItems,
  type WorkingLocationRailItem,
} from "../layout/workingLocationRail";
import { minutesToPx, WEEKDAY_LABELS } from "../layout/gridMetrics";
import { panelAnchors, panelSlideDirection } from "../layout/dayGrid";
import { useSwipeNavigation } from "../hooks/useSwipeNavigation";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { type CalendarInfo } from "./EventBlock";
import { AllDayBar } from "./AllDayBar";
import { DayColumn } from "./DayColumn";
import { TaskRow } from "./TaskRow";
import { GitHubLane } from "./GitHubLane";
import "./WeekGrid.css";

const INITIAL_SCROLL_HOUR = 8;
const SLIDE_MS = 200;

/**
 * 終日レーン(フェーズ5)のレイアウト定数。ROW_HEIGHT はバー1行ぶんの px 高さ、
 * MAX_VISIBLE_ROWS は実際にバーとして描画する最大行数(それを超える分は
 * 日ごとの「+N」表示にまとめる、Google カレンダーの月表示と同じ考え方)
 */
const ALLDAY_ROW_HEIGHT = 20;
const ALLDAY_MAX_VISIBLE_ROWS = 3;

interface WeekGridProps {
  store: OccurrenceStore;
  /** 終日予定 (フェーズ5) の読み口。時刻予定の store と対になる別ストア */
  allDayStore: AllDayStore;
  /** Google タスク (docs/google-tasks.md) の読み口。due 付きタスクを日付レーンに表示する */
  taskStore: TaskStore;
  /**
   * GitHub 連携 (docs/github-integration.md フェーズ①Part B) の読み口。milestone/issue/PR を
   * 終日レーンの直下の専用レーンに表示する。未連携時は常に空のストアが渡る想定で、
   * その場合レーンごと非表示になる(App.tsx 側は無条件にインスタンスを用意する)
   */
  githubStore: GitHubStore;
  /**
   * GitHub 実績オーバーレイ(docs/github-integration.md フェーズ③Part B)の生データ。
   * milestone/issue/PR (githubStore) と違い commit 実績はライブ取得のみで IndexedDB に
   * キャッシュしない(App.tsx が表示中の時間範囲ぶんを都度 GET /api/github/activity で
   * 取得して渡す)。ここでは受け取って sync/mapActivity.ts の layoutDayActivity で
   * 日ごとのクラスタへ変換し、DayColumn の右端レールへ渡すだけ。未連携・トグル OFF 時は
   * 空配列が渡る想定(その場合レールは自然に何も描画しない)。
   */
  githubActivity: GitHubActivityDTO[];
  /**
   * GitHub CI/Actions 実行オーバーレイ(docs/github-integration.md フェーズ④b「CI/Actions
   * 実行をタイムラインに薄く重ねる」)の生データ。githubActivity(commit 実績)と同じく
   * ライブ取得のみで IndexedDB にキャッシュしない(App.tsx が表示中の時間範囲ぶんを都度
   * GET /api/github/ci で取得して渡す)。ここでは受け取って sync/mapCiRuns.ts の
   * layoutDayCiRuns で日ごとのクラスタへ変換し、DayColumn の左端レールへ渡すだけ。
   * 未連携・トグル OFF 時は空配列が渡る想定(その場合レールは自然に何も描画しない)。
   */
  githubCiRuns: GitHubCiRunDTO[];
  /**
   * 予定タイムブロック(docs/github-integration.md「時間計測」増分1)の読み口。
   * occurrences とは完全に独立したストア(Google 同期には一切触れられない)。
   */
  plannedStore: PlannedStore;
  /** 作業キューからこの列へドロップされたときに呼ばれる(ローカルのみ。DayColumn.tsx 参照) */
  onDropWorkItem: (item: DroppedWorkItem, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの移動/リサイズ確定時に呼ばれる(ローカルのみ) */
  onMovePlannedBlock: (id: string, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの削除ボタンから呼ばれる(ローカルのみ) */
  onDeletePlannedBlock: (id: string) => void;
  /**
   * 手動タイマー(docs/github-integration.md「時間計測」増分2)の読み口。plannedStore と同様
   * Google 同期には一切触れられない別ストア。ここで走行中エントリを購読し、linkedItemId 集合へ
   * 変換してから DayColumn(→PlannedBlockCard)へ渡す(各カードでの isRunning 判定を軽くするため)。
   */
  timeEntryStore: TimeEntryStore;
  /** ▶ ボタンから呼ばれる(ローカルのみ) */
  onStartTimer: (block: PlannedBlock) => void;
  /** ⏹ ボタンから呼ばれる(ローカルのみ)。対象 item だけを止める */
  onStopTimer: (linkedItemId: string) => void;
  /** 表示中パネルの先頭日。週ビュー(dayCount=7)なら月曜、day3/day1 ビューなら任意の起点日 */
  weekStart: Temporal.PlainDate;
  /**
   * 表示日数 N(モバイル対応フェーズ2、docs/multiplatform.md)。7=週ビュー(既定・従来挙動)、
   * 3/1=モバイルの3日/1日タイムライン。3週ストリップ相当の「N日×3パネル」・ナビ(N日送り)・
   * ヘッダー/終日レーン/時刻グリッドの列数がすべてこれに追従する
   */
  dayCount: number;
  timeZone: string;
  /**
   * ドラッグ確定時、store.update に加えて呼ばれる永続化フック
   * (IndexedDB 書き込み・Google 由来なら書き戻しは App 側が担う)。
   * previous は store.update 直前の occurrence (ロールバック用のスナップショット)
   */
  onPersist: (updated: Occurrence, previous: Occurrence | undefined) => void;
  /**
   * ドラッグ移動 (kind==='move') の確認ダイアログを開くフック(フェーズ2、2026-07-22)。
   * handleCommit が store.update で楽観的に見た目だけ反映した直後に呼ばれる ―― まだ
   * onPersist (IndexedDB/Google 書き込み) は呼んでいない状態。App.tsx がこれを state に
   * 保持して MoveConfirmDialog を描画し、「移動する」で onPersist(updated, previous) を、
   * 「キャンセル」で store.update(previous) だけを呼ぶ(sync/moveConfirm.ts 参照)。
   */
  onRequestMoveConfirm: (updated: Occurrence, previous: Occurrence) => void;
  /**
   * 選択中カレンダーの `${accountId}:${calendarId}` キー集合(マルチアカウント対応 2026-07-19)。
   * source==='google' な occurrence だけをこれでフィルタする。ローカル/未設定 source
   * (source !== 'google') は選択状態に関係なく常に表示する。
   */
  visibleCalendarKeys: Set<string>;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventBlock の詳細ポップオーバーが「どのカレンダーか」を出すのに使う */
  calendarLookup: Map<string, CalendarInfo>;
  /** 詳細ポップオーバーの「削除」導線から呼ばれる(フェーズ5、google 由来の occurrence のみ) */
  onDelete: (occurrence: Occurrence) => void;
  /** 詳細ポップオーバーの編集フォーム「保存」から呼ばれる(フェーズ2、2026-07-22) */
  onSaveEdit: (occurrence: Occurrence, draft: EventEditDraft) => Promise<void>;
  /** 終日レーンの詳細ポップオーバーの編集フォーム「保存」から呼ばれる(フェーズ2、2026-07-22) */
  onSaveAllDayEdit: (occurrence: AllDayOccurrence, draft: EventEditDraft) => Promise<void>;
  /** 詳細ポップオーバーの RSVP ボタンから呼ばれる(フェーズ2、2026-07-22) */
  onRsvp: (occurrence: Occurrence, status: RsvpResponseStatus) => Promise<void>;
  /** 終日レーンの詳細ポップオーバーの RSVP ボタンから呼ばれる(フェーズ2、2026-07-22) */
  onAllDayRsvp: (occurrence: AllDayOccurrence, status: RsvpResponseStatus) => Promise<void>;
  /** 新規予定の書き込み先。null なら空き領域クリック/ドラッグでの新規作成を無効化する(DayColumn 参照) */
  writeTarget: WriteTargetCandidate | null;
  /** 空き領域クリック/ドラッグでタイトル確定時に呼ばれる新規作成フック(フェーズ5) */
  onCreateEvent: (
    startMs: number,
    endMs: number,
    title: string,
    target: WriteTargetCandidate,
  ) => void;
  /** タスク行の枡チェックボックスのタップで呼ぶ(完了⇔未完了トグル、docs/google-tasks.md) */
  onToggleTask: (task: TaskItem) => void;
  /**
   * タスクリスト表示 ON/OFF(左ペイン増分2、2026-07-22)。明示的に非表示にした
   * `${accountId}:${taskListId}` の集合(db/database.ts の getHiddenTaskLists と同じ形、
   * デフォルト全 ON)。visibleCalendarKeys とは判定方向が逆(こちらは「入っていたら隠す」)
   * なので、TaskItem に対しては has() の結果をそのまま除外条件に使う。
   */
  hiddenTaskListKeys: Set<string>;
  /**
   * 「不参加を表示」設定 (参加ステータス表示、2026-07-22)。showDeclined: false のとき、
   * declined な occurrence/allDayOccurrence を visibleOccurrences/visibleAllDayOccurrences の
   * 組み立て時点で除外する(shouldHideDeclined、sync/declinedVisibility.ts)。ここで除外した
   * 分は packColumns の入力にも、oooRail.ts が visibleOccurrences から不在分を切り出す入力にも
   * 含まれなくなる ―― WeekGrid/AllDayBar/OOO レールを1箇所のフィルタで一貫して除外できる
   * (visibleCalendarKeys と同じ「occurrences を filter する時点で一度だけ効かせる」設計)。
   */
  declinedVisibility: DeclinedVisibilitySettings;
  /**
   * モバイル対応フェーズ2: true のとき、DayColumn の空き領域からの新規作成トリガーを
   * 即時クリックではなく長押し(~500ms)起点にする(スクロールとの競合を避けるため)。
   * 省略時は false(既存のデスクトップ向け即時クリック挙動を維持)
   */
  longPressCreate?: boolean;
  /**
   * スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22)。横スワイプが
   * 「前/次パネルへの確定」と判定されたとき(hooks/useSwipeNavigation.ts)に呼ばれる。
   * App.tsx は既存の goToPrev/goToNext(ツールバー矢印ボタンと同じ関数)をそのまま渡す想定
   * ―― timelineStart の更新は App 側に一本化し、WeekGrid は「確定した」ことだけを伝える。
   * 省略時はスワイプ自体を無効化する(longPressCreate と同じく、呼び出し側が明示的に
   * 対応する場合のみ有効になるオプトイン設計)。
   */
  onSwipeNavigate?: (direction: "prev" | "next") => void;
}

type SlidePhase = "idle" | "next" | "prev";

/**
 * phase が指す strip の基準 translateX(%)。3週(prev/current/next)のうち中央(=index1)が既定表示。
 * この値を stripStyle の CSS 変数 --strip-base として渡し、CSS 側で
 * translateX(calc(var(--strip-base) + var(--swipe-dx))) と合成する(--swipe-dx は指追従オフセット px)。
 */
const PHASE_BASE_PERCENT: Record<SlidePhase, number> = {
  prev: 0,
  idle: -33.3333,
  next: -66.6667,
};

interface WeekPanelData {
  panelStart: Temporal.PlainDate;
  days: Temporal.PlainDate[];
  dayStarts: number[];
  dayEnds: number[];
  dayData: {
    day: Temporal.PlainDate;
    positioned: ReturnType<typeof packColumns<OccurrenceGroup>>;
    /** この日ぶんの不在(時刻予定側)。packColumns の入力からは除外済み(oooRail.ts 参照) */
    oooItems: OooRailItem[];
    /**
     * この日ぶんの勤務場所レール項目(帯表示、時刻予定専用。2026-07-22 終日レーンへ統合 ――
     * 終日の勤務場所はもうここに含まれない、AllDayBar 側の通常フローで表示される)。
     * OOO と同じく packColumns の入力(cardGroups)から除外済み
     * (layout/workingLocationRail.ts 参照)。
     */
    workingLocationItems: WorkingLocationRailItem[];
  }[];
}

/** 終日レーンの「+N」表示用。非表示になったバーの件数とタイトル一覧(title 属性で列挙する) */
interface AllDayOverflowInfo {
  count: number;
  titles: string[];
}

export function WeekGrid({
  store,
  allDayStore,
  taskStore,
  githubStore,
  githubActivity,
  githubCiRuns,
  plannedStore,
  onDropWorkItem,
  onMovePlannedBlock,
  onDeletePlannedBlock,
  timeEntryStore,
  onStartTimer,
  onStopTimer,
  weekStart,
  dayCount,
  timeZone,
  onPersist,
  onRequestMoveConfirm,
  visibleCalendarKeys,
  calendarLookup,
  onDelete,
  onSaveEdit,
  onSaveAllDayEdit,
  onRsvp,
  onAllDayRsvp,
  writeTarget,
  onCreateEvent,
  onToggleTask,
  hiddenTaskListKeys,
  declinedVisibility,
  longPressCreate = false,
  onSwipeNavigate,
}: WeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // スワイプの1パネルぶんの幅(px)を測る参照先。常に描画される days-viewport を使う
  // (header/allday/tasks/github の各 viewport も同じ幅だが、日付タイムラインは
  // 表示・非表示のトグルが無く常に存在するためこれが最も安定した測定元)
  const daysViewportRef = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Temporal.Now.instant().epochMilliseconds);

  // 手動タイマー(増分2): 走行中エントリの linkedItemId 集合。DayColumn 全体で1回だけ計算し、
  // 各 PlannedBlockCard は Set.has() だけで isRunning を判定する(N個のカードごとに store を
  // 舐め直さない)
  const runningTimeEntries = useRunningTimeEntries(timeEntryStore);
  const runningLinkedItemIds = useMemo(
    () => new Set(runningTimeEntries.map((e) => e.linkedItemId)),
    [runningTimeEntries],
  );

  // 表示中(=アニメーション完了済み)の中央週。ストリップは常にこの ±1週の3週ぶんだけ DOM を持つ
  const [center, setCenter] = useState(weekStart);
  const [phase, setPhase] = useState<SlidePhase>("idle");
  // true の間は transform の transition を切る(スワップ直後の瞬間ジャンプを無アニメで行うため)
  const [instant, setInstant] = useState(true);
  const slideTimeoutRef = useRef<number | undefined>(undefined);
  // .week-grid ルート。スワイプ指追従は React state ではなくここへ CSS 変数(--swipe-dx)を
  // 命令的にセットして行う(pointermove ごとに WeekGrid 全体を再レンダーするとカクつくため)。
  const gridRootRef = useRef<HTMLDivElement | null>(null);

  // 要件6: prefers-reduced-motion: reduce では追従アニメを最小化し、スナップを即時にする。
  // 既存の SLIDE_MS(週送りボタン等と共通のスナップ所要時間)をそのまま流用しつつ、
  // reduce のときだけ 0ms にする(トークンを増やさず既存の1つの定数を条件分岐するだけ)。
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const effectiveSlideMs = prefersReducedMotion ? 0 : SLIDE_MS;

  // 現在時刻線を1分ごとに更新
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Temporal.Now.instant().epochMilliseconds);
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // 初期スクロール位置を朝8時あたりに合わせる
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: minutesToPx(INITIAL_SCROLL_HOUR * 60) });
  }, []);

  // weekStart (App が持つ状態) が変わったら center に反映する。
  // ちょうど隣パネル(dayCount日ぶん)への移動ならスライドアニメーションし、
  // それ以外(today ジャンプ・ビュー切替等)は瞬時に切り替える。
  useEffect(() => {
    if (weekStart.equals(center)) return;
    if (slideTimeoutRef.current !== undefined) {
      window.clearTimeout(slideTimeoutRef.current);
      slideTimeoutRef.current = undefined;
    }
    const direction = panelSlideDirection(center, weekStart, dayCount);

    // スワイプ確定の瞬間もここへ合流する(handleSwipeEnd → onSwipeNavigate → App.tsx の
    // goToPrev/goToNext → weekStart 更新、という経路で他のナビゲーションと同じ effect を通る)。
    // 指追従の水平オフセット --swipe-dx を「phase 切替(=--strip-base を隣パネルへ)」と同じこの
    // バッチで 0 に戻す ―― handleSwipeEnd 側で先に 0 に戻すと、この effect(paint 後実行)より前に
    // 一旦中央へ戻る2段階のカクつきになるため、指の位置(--swipe-dx=finger)を保ったままここまで来て、
    // phase 切替と同時に 0 にする。これで指を離した位置から隣パネルへ1回の transition で滑らかに
    // スナップする。トグルボタン等スワイプ以外の経路では --swipe-dx は既に 0(0→0 は無害)。
    gridRootRef.current?.style.setProperty("--swipe-dx", "0px");

    if (direction !== 0) {
      setInstant(false);
      setPhase(direction === 1 ? "next" : "prev");
      slideTimeoutRef.current = window.setTimeout(() => {
        setInstant(true);
        setPhase("idle");
        setCenter(weekStart);
        // instant での瞬間ジャンプが確実に1フレーム描画されてから transition を戻す
        requestAnimationFrame(() => {
          requestAnimationFrame(() => setInstant(false));
        });
      }, effectiveSlideMs);
    } else {
      setInstant(true);
      setPhase("idle");
      setCenter(weekStart);
    }
    // center は effect 内でのみ更新するので依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, dayCount, effectiveSlideMs]);

  useEffect(
    () => () => {
      if (slideTimeoutRef.current !== undefined) window.clearTimeout(slideTimeoutRef.current);
    },
    [],
  );

  // スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22。追従を CSS 変数化して
  // カクつき解消 + スナップ改善、2026-07-23)。実際の pointer 配線・方向判定は
  // hooks/useSwipeNavigation.ts(判定/数値計算は layout/swipeNav.ts の純関数)に委譲し、ここでは
  // 追従(--swipe-dx の命令的セット)・スナップ(.is-swiping の付け外し)・確定時の呼び出し先
  // (onSwipeNavigate、App.tsx の goToPrev/goToNext)を配線する。
  //
  // enabled は「longPressCreate(=isNarrow、モバイル幅)かつ、前回のスナップアニメーションが
  // 終わって phase==='idle' のとき」だけ ―― longPressCreate=false(デスクトップの即時作成
  // ドラッグ)との衝突を避け(useSwipeNavigation.ts のコメント参照)、アニメーション中の
  // 割り込みも防ぐ。onSwipeNavigate が渡されていなければ(App.tsx が対応していない/
  // 呼び出し側の意図的な無効化)常に無効。
  const swipeEnabled = Boolean(onSwipeNavigate) && longPressCreate && phase === "idle";

  // 指追従の水平オフセットを --swipe-dx として .week-grid ルートへ命令的に反映する(React 再レンダー
  // なし)。CSS 側で transform: translateX(calc(var(--strip-base) + var(--swipe-dx))) が全 strip に効く。
  const setSwipeDx = useCallback((dxPx: number) => {
    gridRootRef.current?.style.setProperty("--swipe-dx", `${dxPx}px`);
  }, []);

  // 横スワイプ確定: transition を切って(.is-swiping)1:1 で指に追従できる状態にする。
  const handleSwipeStart = useCallback(() => {
    gridRootRef.current?.classList.add("is-swiping");
    setSwipeDx(0);
  }, [setSwipeDx]);

  const handleSwipeMove = useCallback((dxPx: number) => setSwipeDx(dxPx), [setSwipeDx]);

  // 指を離したとき: .is-swiping を外して inline の transition(Xms ease)を復活させ、スナップさせる。
  // - 'stay': weekStart が変わらず上の useEffect は走らないので、ここで --swipe-dx=0 に戻す
  //   →基準%(中央)へアニメーションで戻る。
  // - 'prev'/'next': ここでは --swipe-dx をまだ 0 に戻さない。onSwipeNavigate で weekStart を動かし、
  //   上の useEffect が「phase 切替(=--strip-base を隣パネルへ)」と「--swipe-dx=0」を同じバッチで
  //   行う。ここで先に 0 に戻すと、phase 切替(effect は paint 後実行)より前に一旦中央へ戻る2段階の
  //   カクつきになるため、指の位置(--swipe-dx=finger)を保ったまま effect に委ねる。
  const handleSwipeEnd = useCallback(
    (outcome: "prev" | "next" | "stay") => {
      gridRootRef.current?.classList.remove("is-swiping");
      if (outcome === "stay") {
        setSwipeDx(0);
        return;
      }
      onSwipeNavigate?.(outcome);
    },
    [setSwipeDx, onSwipeNavigate],
  );

  const swipeHandlers = useSwipeNavigation({
    enabled: swipeEnabled,
    viewportRef: daysViewportRef,
    onSwipeStart: handleSwipeStart,
    onSwipeMove: handleSwipeMove,
    onSwipeEnd: handleSwipeEnd,
  });

  // 3パネル(prev/current/next)の先頭日。dayCount=7 なら従来通り「3週」、3/1 なら
  // 「3×N日」ぶんのストリップになる(panelAnchors、dayGrid.ts)
  const panelStarts = useMemo(() => panelAnchors(center, dayCount), [center, dayCount]);

  const todayPlainDate = useMemo(
    () => Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(timeZone).toPlainDate(),
    [nowMs, timeZone],
  );

  const rangeStartMs = useMemo(
    () => panelStarts[0].toZonedDateTime({ timeZone }).epochMilliseconds,
    [panelStarts, timeZone],
  );
  const rangeEndMs = useMemo(
    () => panelStarts[2].add({ days: dayCount }).toZonedDateTime({ timeZone }).epochMilliseconds,
    [panelStarts, dayCount, timeZone],
  );
  const occurrences = useOccurrences(store, rangeStartMs, rangeEndMs);

  // カレンダー選択(マルチアカウント対応 2026-07-19): google 由来だけを
  // visibleCalendarKeys でフィルタする。ローカルデータは常に表示する。
  // 「不参加を表示」設定(参加ステータス表示、2026-07-22): shouldHideDeclined が true を
  // 返した occurrence はここで除外する ―― packColumns の入力からも oooRail.ts が拾う
  // 不在分からも自動的に消える(このコンポーネントの唯一の occurrences フィルタ地点のため)
  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter(
        (o) =>
          (o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`)) &&
          !shouldHideDeclined(o, declinedVisibility),
      ),
    [occurrences, visibleCalendarKeys, declinedVisibility],
  );

  // 同一予定の集約(フェーズ5): iCalUID + startMs + endMs が一致する複数アカウント/
  // カレンダーのコピーを1グループ(1カード)にまとめる。iCalUID が無い occurrence は
  // 単独グループのまま。レンダーごとの再計算を避けるためメモ化する
  const groupedOccurrences = useMemo(
    () => groupDuplicateOccurrences(visibleOccurrences),
    [visibleOccurrences],
  );

  const weekPanels = useMemo<WeekPanelData[]>(
    () =>
      panelStarts.map((panelStart) => {
        const days = Array.from({ length: dayCount }, (_, i) => panelStart.add({ days: i }));
        const dayStarts = days.map((d) => d.toZonedDateTime({ timeZone }).epochMilliseconds);
        const dayEnds = [
          ...dayStarts.slice(1),
          panelStart.add({ days: dayCount }).toZonedDateTime({ timeZone }).epochMilliseconds,
        ];
        const dayData = days.map((day, i) => {
          const items = groupedOccurrences.filter(
            (g) => g.primary.startMs >= dayStarts[i] && g.primary.startMs < dayEnds[i],
          );
          // 不在(Out of Office、2026-07-22): 通常の予定カードとして描画しないため、
          // packColumns の入力(cardGroups)から除外する(カスケード列を消費させない)。
          // 除外した分(oooGroups)は timedOooRailItems で分オフセットへ変換し、そのまま
          // DayColumn の不在レールへ渡す(要件どおり「packColumns 入力から除外」を体現)
          const { cardGroups: oooCardGroups, oooGroups } = splitOutOfOfficeGroups(items);
          // 勤務場所(workingLocation、2026-07-22 作り直し): OOO と全く同じ理由で
          // packColumns の入力からさらに除外する(OOO を除いた残りの oooCardGroups から
          // 分ける ―― 両者は互いに排他な eventType のため順序自体に意味は無いが、
          // 「OOO を先に処理する」既存の流儀にそのまま乗せてある)。
          const { cardGroups, workingLocationGroups } = splitWorkingLocationGroups(oooCardGroups);
          const positioned = packColumns(
            cardGroups,
            (g) => g.primary.startMs,
            (g) => g.primary.endMs,
          );
          const oooItems = timedOooRailItems(oooGroups, dayStarts[i], dayEnds[i]);
          const workingLocationItems = timedWorkingLocationRailItems(
            workingLocationGroups,
            dayStarts[i],
            dayEnds[i],
          );
          return { day, positioned, oooItems, workingLocationItems };
        });
        return { panelStart, days, dayStarts, dayEnds, dayData };
      }),
    [panelStarts, dayCount, groupedOccurrences, timeZone],
  );

  // ---- 終日レーン (フェーズ5) ----
  // 展開ウィンドウの概念が無い終日予定は、表示中3パネルぶんの日付範囲 [fromDate, toDate]
  // (inclusive) をそのまま AllDayStore に問い合わせる(時刻予定の rangeStartMs/EndMs と対応)
  const allDayFromDate = useMemo(() => panelStarts[0].toString(), [panelStarts]);
  const allDayToDate = useMemo(
    () => panelStarts[2].add({ days: dayCount - 1 }).toString(),
    [panelStarts, dayCount],
  );
  const allDayOccurrencesRaw = useAllDayOccurrences(allDayStore, allDayFromDate, allDayToDate);

  // カレンダー選択・同一予定集約・「不参加を表示」フィルタは時刻予定と同じ扱い(要望どおり)
  const visibleAllDayOccurrences = useMemo(
    () =>
      allDayOccurrencesRaw.filter(
        (o) =>
          (o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`)) &&
          !shouldHideDeclined(o, declinedVisibility),
      ),
    [allDayOccurrencesRaw, visibleCalendarKeys, declinedVisibility],
  );
  // 不在(Out of Office、2026-07-22): 終日レーン(AllDayBar)のチップとしては出さず、
  // 該当日の DayColumn 側に「その日の全高ライン」として合流させる(要件)。ここで
  // barGroups(従来通り packDayBars → AllDayBar へ)と oooGroups(下記 allDayOooPanels へ)に
  // 振り分ける。
  // 勤務場所(workingLocation)はここではもう分離しない(2026-07-22 終日レーンへ統合 ――
  // 従来は OOO と同じく専用レールへ全高帯として振り分けていたが、「他の終日予定と並べて
  // 見たい」というユーザー要望により、終日ぶんは barGroups に残したまま通常の
  // packDayBars/AllDayBar 経路に流すよう変更した。見た目の分岐(薄墨枡色+地図ピン)は
  // AllDayBar.tsx が occurrence.isWorkingLocation を直接見て行う
  // (layout/workingLocationRail.ts の isWorkingLocation を再利用、時刻予定側の判定関数と共通)。
  const { groupedAllDayBarOccurrences, groupedAllDayOooOccurrences } = useMemo(() => {
    const { barGroups, oooGroups } = splitOutOfOfficeAllDayGroups(
      groupDuplicateAllDayOccurrences(visibleAllDayOccurrences),
    );
    return {
      groupedAllDayBarOccurrences: barGroups,
      groupedAllDayOooOccurrences: oooGroups,
    };
  }, [visibleAllDayOccurrences]);

  // パネルごとに、その N 日ぶんのインデックス [0, dayCount-1] にクリップした区間で
  // packDayBars する。行の割り当てはここで確定するが、「何行まで見せるか
  // (sharedVisibleRows)」は3パネル分の最大行数を見てから決めるため、この時点では
  // 行を絞り込まない
  const rawAllDayPanels = useMemo(
    () =>
      panelStarts.map((panelStart) => {
        const panelEndDate = panelStart.add({ days: dayCount - 1 });
        const relevant = groupedAllDayBarOccurrences.filter((g) => {
          const s = Temporal.PlainDate.from(g.primary.startDate);
          const e = Temporal.PlainDate.from(g.primary.endDate);
          return (
            Temporal.PlainDate.compare(s, panelEndDate) <= 0 &&
            Temporal.PlainDate.compare(e, panelStart) >= 0
          );
        });
        const clipped = relevant.map((group) => {
          const s = Temporal.PlainDate.from(group.primary.startDate);
          const e = Temporal.PlainDate.from(group.primary.endDate);
          const startDayIndex = Math.max(0, panelStart.until(s, { largestUnit: "day" }).days);
          const endDayIndex = Math.min(
            dayCount - 1,
            panelStart.until(e, { largestUnit: "day" }).days,
          );
          return { group, startDayIndex, endDayIndex };
        });
        const positioned = packDayBars(
          clipped,
          (b) => b.startDayIndex,
          (b) => b.endDayIndex,
        );
        return {
          panelStart,
          bars: positioned.map((p) => ({ ...p.item, row: p.row })),
        };
      }),
    [panelStarts, dayCount, groupedAllDayBarOccurrences],
  );

  // 終日の不在を日ごとに割り当てる。weekPanels と同じ panelStarts 由来なので index が揃う
  // (activityPanels/ciPanels と同じ流儀)。時刻予定側の oooItems (weekPanels の dayData) と
  // 合わせて DayColumn の oooItems prop へマージするのは JSX 側(下記)で行う。
  const allDayOooPanels = useMemo(
    () =>
      panelStarts.map((panelStart) => ({
        panelStart,
        dayItems: Array.from({ length: dayCount }, (_, i) =>
          allDayOooRailItems(groupedAllDayOooOccurrences, panelStart.add({ days: i })),
        ),
      })),
    [panelStarts, dayCount, groupedAllDayOooOccurrences],
  );

  // 3週(prev/current/next)で共有する表示行数。行数が多い日があっても最大 3 行までバーを見せ、
  // それを超える分は「+N」に畳む。3週の中で1週でも溢れていれば +N 用の1行を全週共通で確保する
  // (パネルごとに高さが変わるとスライドアニメーション中に見た目が揃わないため)
  const { allDayVisibleRows, allDayHasOverflow } = useMemo(() => {
    let maxRows = 0;
    let anyOverflow = false;
    for (const panel of rawAllDayPanels) {
      for (const bar of panel.bars) {
        maxRows = Math.max(maxRows, bar.row + 1);
        if (bar.row >= ALLDAY_MAX_VISIBLE_ROWS) anyOverflow = true;
      }
    }
    return {
      allDayVisibleRows: Math.min(ALLDAY_MAX_VISIBLE_ROWS, maxRows),
      allDayHasOverflow: anyOverflow,
    };
  }, [rawAllDayPanels]);
  const allDayLaneRows = allDayVisibleRows + (allDayHasOverflow ? 1 : 0);

  const allDayPanels = useMemo(
    () =>
      rawAllDayPanels.map(({ panelStart, bars }) => {
        const visibleBars = bars.filter((b) => b.row < allDayVisibleRows);
        const overflowByDay: AllDayOverflowInfo[] = Array.from({ length: dayCount }, () => ({
          count: 0,
          titles: [],
        }));
        for (const b of bars) {
          if (b.row < allDayVisibleRows) continue;
          for (let d = b.startDayIndex; d <= b.endDayIndex; d++) {
            overflowByDay[d].count++;
            overflowByDay[d].titles.push(b.group.primary.title);
          }
        }
        return { panelStart, visibleBars, overflowByDay };
      }),
    [rawAllDayPanels, allDayVisibleRows, dayCount],
  );

  // ---- タスクレーン (docs/google-tasks.md) ----
  // 終日レーンと同じ日付範囲([fromDate, toDate] inclusive、表示中3パネルぶん)を TaskStore に
  // 問い合わせる。タスクは複数日にまたがらない(due は単一の日付)ため、終日バーのような
  // packDayBars は不要 — 日ごとに単純にリストアップするだけでよい。
  // タスクリスト表示 ON/OFF(左ペイン増分2): hiddenTaskListKeys に入っている
  // (accountId, taskListId) のタスクだけを除外する(visibleCalendarKeys と違い、
  // タスクは source 分岐が無く常にこの1本のフィルタだけを通る)。
  const tasksRawAll = useTasks(taskStore, allDayFromDate, allDayToDate);
  const tasksRaw = useMemo(
    () => tasksRawAll.filter((t) => !hiddenTaskListKeys.has(`${t.accountId}:${t.taskListId}`)),
    [tasksRawAll, hiddenTaskListKeys],
  );

  const taskPanels = useMemo(
    () =>
      panelStarts.map((panelStart) => {
        const dayTasks = Array.from({ length: dayCount }, (_, i) => {
          const dateStr = panelStart.add({ days: i }).toString();
          return tasksRaw.filter((t) => t.dueDate === dateStr);
        });
        return { panelStart, dayTasks };
      }),
    [panelStarts, dayCount, tasksRaw],
  );
  // 表示中3パネルのどこかにタスクが1件でもあればレーンごと表示する(終日レーンと同じ流儀)
  const taskLaneHasContent = tasksRaw.length > 0;

  // ---- GitHub レーン (docs/github-integration.md フェーズ①Part B) ----
  // 時刻予定と同じ [rangeStartMs, rangeEndMs) (表示中3パネルぶん) を GitHubStore に問い合わせる。
  // dateMs は epoch ms の一時点(終日予定の startDate/endDate のような幅を持たない)なので、
  // 日ごとの割り当ては weekPanels が既に持つ dayStarts/dayEnds (時刻予定と同じ壁時計境界) を
  // そのまま再利用する — 別途タイムゾーン変換をやり直さない
  const githubItemsRaw = useGitHubItems(githubStore, rangeStartMs, rangeEndMs);

  const githubPanels = useMemo(
    () =>
      weekPanels.map(({ panelStart, dayStarts, dayEnds }) => ({
        panelStart,
        dayLayouts: dayStarts.map((dayStart, i) =>
          layoutGitHubDay(githubItemsRaw, dayStart, dayEnds[i]),
        ),
      })),
    [weekPanels, githubItemsRaw],
  );
  // 未連携・0件ならレーンごと非表示にする(終日/タスクレーンと同じ流儀)
  const githubLaneHasContent = githubItemsRaw.length > 0;

  // ---- GitHub 実績オーバーレイ (docs/github-integration.md フェーズ③Part B) ----
  // githubPanels と同じ形だが、レーンではなく日列(weekPanels の dayData)に直接
  // 差し込むため、weekPanels が既に持つ dayStarts/dayEnds(時刻予定と同じ壁時計境界)を
  // そのまま使う。panelStarts 由来で weekPanels/activityPanels は常に同じ順序・件数になる
  // (どちらも同じ panelStarts.map(...) から作るため index が揃う)
  const activityPanels = useMemo(
    () =>
      weekPanels.map(({ panelStart, dayStarts, dayEnds }) => ({
        panelStart,
        dayClusters: dayStarts.map((dayStart, i) =>
          layoutDayActivity(githubActivity, dayStart, dayEnds[i]),
        ),
      })),
    [weekPanels, githubActivity],
  );

  // ---- GitHub CI/Actions 実行オーバーレイ (docs/github-integration.md フェーズ④b) ----
  // activityPanels と全く同じ形・同じ理由(weekPanels の dayStarts/dayEnds をそのまま使い、
  // panelStarts 由来で index が揃う)。commit 実績と CI 実行は独立した2系統のデータなので
  // 別々の state・別々のクラスタ化(layoutDayCiRuns)を経て、DayColumn には別々の prop
  // (activityClusters は右端レール、ciClusters は左端レール)として渡す。
  const ciPanels = useMemo(
    () =>
      weekPanels.map(({ panelStart, dayStarts, dayEnds }) => ({
        panelStart,
        dayClusters: dayStarts.map((dayStart, i) =>
          layoutDayCiRuns(githubCiRuns, dayStart, dayEnds[i]),
        ),
      })),
    [weekPanels, githubCiRuns],
  );

  // ---- 予定タイムブロック (docs/github-integration.md「時間計測」増分1) ----
  // 時刻予定と同じ [rangeStartMs, rangeEndMs) を PlannedStore に問い合わせ、weekPanels と
  // 同じ dayStarts/dayEnds(壁時計境界)で日ごとに割り当てる(activityPanels と同じ流儀)。
  // カレンダー選択・同一予定集約の対象外(ローカル専用なので常に全件表示)
  const plannedBlocksRaw = usePlannedBlocks(plannedStore, rangeStartMs, rangeEndMs);

  const plannedPanels = useMemo(
    () =>
      weekPanels.map(({ panelStart, dayStarts, dayEnds }) => ({
        panelStart,
        dayBlocks: dayStarts.map((dayStart, i) =>
          plannedBlocksRaw.filter((b) => b.startMs < dayEnds[i] && b.endMs > dayStart),
        ),
      })),
    [weekPanels, plannedBlocksRaw],
  );

  const handleCommit = useCallback(
    (updated: Occurrence, kind: "move" | "resize") => {
      // ロールバック用に更新前のスナップショットを取ってから、楽観的・同期に
      // store を即座に更新して見た目に反映する
      const previous = store.get(updated.id);
      store.update(updated);

      // 実質変化なし(スナップ後に元の位置/長さへ戻った等): 確認も永続化も不要
      if (previous && !hasOccurrenceTimeChanged(previous, updated)) return;

      // 移動確認ダイアログ(フェーズ2、2026-07-22): kind==='move' のときだけ挟む
      // (リサイズは現状どおり即確定、ユーザー決定)。previous が無い(理論上起きないはずの
      // 保険パス)場合は確認を挟まずそのまま永続化する。
      if (kind === "move" && previous) {
        onRequestMoveConfirm(updated, previous);
        return;
      }
      // 永続化は非同期・fire-and-forget(App 側が db 書き込み・Google 書き戻しを担当)
      onPersist(updated, previous);
    },
    [store, onPersist, onRequestMoveConfirm],
  );

  // strip の transform は CSS 側(WeekGrid.css)で translateX(calc(var(--strip-base) + var(--swipe-dx)))
  // として定義してある。ここでは phase の基準%を --strip-base として渡すだけ ―― 指追従の --swipe-dx は
  // handleSwipeMove が命令的にセットする(React 再レンダー回避)。5つの strip が同じ stripStyle を共有。
  const stripStyle = {
    "--strip-base": `${PHASE_BASE_PERCENT[phase]}%`,
    transition: instant ? "none" : `transform ${effectiveSlideMs}ms ease`,
  } as CSSProperties;
  // 7列固定だった grid-template-columns を dayCount 列へ一般化する(WeekGrid.css 側は
  // repeat(7, 1fr) をフォールバック値として残してあるが、常にこのインライン値で上書きする)
  const panelColumnsStyle = { gridTemplateColumns: `repeat(${dayCount}, 1fr)` };

  return (
    <div
      className="week-grid"
      ref={gridRootRef}
      onPointerDown={swipeHandlers.onPointerDown}
      onPointerMove={swipeHandlers.onPointerMove}
      onPointerUp={swipeHandlers.onPointerUp}
      onPointerCancel={swipeHandlers.onPointerCancel}
    >
      <div className="week-grid-header">
        <div className="week-grid-header-gutter" />
        <div className="week-grid-header-viewport">
          <div className="week-grid-header-strip" style={stripStyle}>
            {weekPanels.map(({ panelStart, days }) => (
              <div
                className="week-grid-header-panel"
                key={panelStart.toString()}
                style={panelColumnsStyle}
              >
                {days.map((day) => {
                  const isToday = day.equals(todayPlainDate);
                  return (
                    <div
                      key={day.toString()}
                      className={isToday ? "week-grid-day-header is-today" : "week-grid-day-header"}
                    >
                      <span className="weekday">{WEEKDAY_LABELS[day.dayOfWeek - 1]}</span>
                      <span className="date">
                        {isToday ? <span className="date-num">{day.day}</span> : day.day}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {allDayLaneRows > 0 && (
        <div className="week-grid-allday">
          <div className="week-grid-allday-gutter">終日</div>
          <div className="week-grid-allday-viewport">
            <div className="week-grid-allday-strip" style={stripStyle}>
              {allDayPanels.map(({ panelStart, visibleBars, overflowByDay }) => (
                <div
                  className="week-grid-allday-panel"
                  key={panelStart.toString()}
                  style={{
                    ...panelColumnsStyle,
                    gridTemplateRows: `repeat(${allDayLaneRows}, ${ALLDAY_ROW_HEIGHT}px)`,
                  }}
                >
                  {visibleBars.map((b) => (
                    <AllDayBar
                      key={b.group.primary.id}
                      occurrence={b.group.primary}
                      groupMembers={b.group.members}
                      row={b.row + 1}
                      colStart={b.startDayIndex + 1}
                      colEnd={b.endDayIndex + 2}
                      calendarLookup={calendarLookup}
                      timeZone={timeZone}
                      onSaveEdit={onSaveAllDayEdit}
                      onRsvp={onAllDayRsvp}
                    />
                  ))}
                  {overflowByDay.map((info, dayIndex) =>
                    info.count > 0 ? (
                      <div
                        key={`overflow-${dayIndex}`}
                        className="allday-overflow"
                        style={{ gridRow: allDayVisibleRows + 1, gridColumn: dayIndex + 1 }}
                        title={info.titles.join("\n")}
                      >
                        +{info.count}
                      </div>
                    ) : null,
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {taskLaneHasContent && (
        <div className="week-grid-tasks">
          <div className="week-grid-tasks-gutter">タスク</div>
          <div className="week-grid-tasks-viewport">
            <div className="week-grid-tasks-strip" style={stripStyle}>
              {taskPanels.map(({ panelStart, dayTasks }) => (
                <div
                  className="week-grid-tasks-panel"
                  key={panelStart.toString()}
                  style={panelColumnsStyle}
                >
                  {dayTasks.map((tasksOfDay, dayIndex) => (
                    // eslint-disable-next-line react/no-array-index-key -- 列の並びは固定(dayCount ぶんの日付インデックス)
                    <div className="task-lane-day" key={dayIndex}>
                      {tasksOfDay.map((task) => (
                        <TaskRow key={task.id} task={task} onToggle={onToggleTask} />
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {githubLaneHasContent && (
        <div className="week-grid-github">
          <div className="week-grid-github-gutter">GitHub</div>
          <div className="week-grid-github-viewport">
            <div className="week-grid-github-strip" style={stripStyle}>
              {githubPanels.map(({ panelStart, dayLayouts }) => (
                <div
                  className="week-grid-github-panel"
                  key={panelStart.toString()}
                  style={panelColumnsStyle}
                >
                  {dayLayouts.map(({ visibleGroups, releases, overflowCount }, dayIndex) => (
                    // eslint-disable-next-line react/no-array-index-key -- 列の並びは固定(dayCount ぶんの日付インデックス、タスクレーンと同じ流儀)
                    <GitHubLane
                      key={dayIndex}
                      groups={visibleGroups}
                      releases={releases}
                      overflowCount={overflowCount}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="week-grid-scroll" ref={scrollRef}>
        <div className="week-grid-body">
          <div className="week-grid-gutter">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="hour-label" style={{ top: minutesToPx(hour * 60) }}>
                {hour}:00
              </div>
            ))}
          </div>

          <div className="week-grid-days-viewport" ref={daysViewportRef}>
            <div className="week-grid-days-strip" style={stripStyle}>
              {weekPanels.map(({ panelStart, dayStarts, dayEnds, dayData }, panelIndex) => (
                <div
                  className="week-grid-days-panel"
                  key={panelStart.toString()}
                  style={panelColumnsStyle}
                >
                  {dayData.map(({ day, positioned, oooItems, workingLocationItems }, dayIndex) => (
                    <DayColumn
                      key={day.toString()}
                      dayIndex={dayIndex}
                      dayStartMs={dayStarts[dayIndex]}
                      dayEndMs={dayEnds[dayIndex]}
                      isToday={day.equals(todayPlainDate)}
                      nowMs={nowMs}
                      positioned={positioned}
                      timeZone={timeZone}
                      weekDayStarts={dayStarts}
                      onCommit={handleCommit}
                      onDelete={onDelete}
                      onSaveEdit={onSaveEdit}
                      onRsvp={onRsvp}
                      calendarLookup={calendarLookup}
                      writeTarget={writeTarget}
                      onCreateEvent={onCreateEvent}
                      longPressCreate={longPressCreate}
                      activityClusters={activityPanels[panelIndex].dayClusters[dayIndex]}
                      // 不在レール: 時刻予定側(oooItems、この日ぶんに既に絞り込み済み)と
                      // 終日側(allDayOooPanels、同じ panelStarts 由来で index が揃う)を
                      // ここで初めてマージする(両者は独立したデータソースのため)
                      oooItems={[...oooItems, ...allDayOooPanels[panelIndex].dayItems[dayIndex]]}
                      // 勤務場所レールは時刻予定側のみ(2026-07-22 終日レーンへ統合 ――
                      // 終日ぶんはもう別途マージしない。上記 workingLocationItems は
                      // weekPanels の dayData 由来で、この日にすでに絞り込み済み)
                      workingLocationItems={workingLocationItems}
                      ciClusters={ciPanels[panelIndex].dayClusters[dayIndex]}
                      plannedBlocks={plannedPanels[panelIndex].dayBlocks[dayIndex]}
                      onDropWorkItem={onDropWorkItem}
                      onMovePlannedBlock={onMovePlannedBlock}
                      onDeletePlannedBlock={onDeletePlannedBlock}
                      runningLinkedItemIds={runningLinkedItemIds}
                      onStartTimer={onStartTimer}
                      onStopTimer={onStopTimer}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
