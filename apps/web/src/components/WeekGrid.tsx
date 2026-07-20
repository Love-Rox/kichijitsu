import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { GitHubActivityDTO } from "@kichijitsu/shared";
import type { Occurrence, PlannedBlock, TaskItem } from "../model/types";
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
import type { DroppedWorkItem } from "../sync/planned";
import { layoutGitHubDay } from "../sync/mapGitHub";
import { layoutDayActivity } from "../sync/mapActivity";
import { packColumns } from "../layout/packColumns";
import { packDayBars } from "../layout/packDayBars";
import {
  groupDuplicateAllDayOccurrences,
  groupDuplicateOccurrences,
  type OccurrenceGroup,
} from "../layout/groupDuplicates";
import { minutesToPx, WEEKDAY_LABELS } from "../layout/gridMetrics";
import { panelAnchors, panelSlideDirection } from "../layout/dayGrid";
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
   * 選択中カレンダーの `${accountId}:${calendarId}` キー集合(マルチアカウント対応 2026-07-19)。
   * source==='google' な occurrence だけをこれでフィルタする。ローカル/未設定 source
   * (source !== 'google') は選択状態に関係なく常に表示する。
   */
  visibleCalendarKeys: Set<string>;
  /** `${accountId}:${calendarId}` → カレンダー名/色。EventBlock の詳細ポップオーバーが「どのカレンダーか」を出すのに使う */
  calendarLookup: Map<string, CalendarInfo>;
  /** 詳細ポップオーバーの「削除」導線から呼ばれる(フェーズ5、google 由来の occurrence のみ) */
  onDelete: (occurrence: Occurrence) => void;
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
   * モバイル対応フェーズ2: true のとき、DayColumn の空き領域からの新規作成トリガーを
   * 即時クリックではなく長押し(~500ms)起点にする(スクロールとの競合を避けるため)。
   * 省略時は false(既存のデスクトップ向け即時クリック挙動を維持)
   */
  longPressCreate?: boolean;
}

type SlidePhase = "idle" | "next" | "prev";

/** phase から strip の transform を求める。3週(prev/current/next)のうち中央(=index1)が既定表示 */
function transformForPhase(phase: SlidePhase): string {
  if (phase === "next") return "translateX(-66.6667%)";
  if (phase === "prev") return "translateX(0%)";
  return "translateX(-33.3333%)";
}

interface WeekPanelData {
  panelStart: Temporal.PlainDate;
  days: Temporal.PlainDate[];
  dayStarts: number[];
  dayEnds: number[];
  dayData: {
    day: Temporal.PlainDate;
    positioned: ReturnType<typeof packColumns<OccurrenceGroup>>;
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
  visibleCalendarKeys,
  calendarLookup,
  onDelete,
  writeTarget,
  onCreateEvent,
  onToggleTask,
  longPressCreate = false,
}: WeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
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
      }, SLIDE_MS);
    } else {
      setInstant(true);
      setPhase("idle");
      setCenter(weekStart);
    }
    // center は effect 内でのみ更新するので依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, dayCount]);

  useEffect(
    () => () => {
      if (slideTimeoutRef.current !== undefined) window.clearTimeout(slideTimeoutRef.current);
    },
    [],
  );

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
  // visibleCalendarKeys でフィルタする。ローカルデータは常に表示する
  const visibleOccurrences = useMemo(
    () =>
      occurrences.filter(
        (o) => o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [occurrences, visibleCalendarKeys],
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
          const positioned = packColumns(
            items,
            (g) => g.primary.startMs,
            (g) => g.primary.endMs,
          );
          return { day, positioned };
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

  // カレンダー選択・同一予定集約は時刻予定と同じ扱い(要望どおり)
  const visibleAllDayOccurrences = useMemo(
    () =>
      allDayOccurrencesRaw.filter(
        (o) => o.source !== "google" || visibleCalendarKeys.has(`${o.accountId}:${o.calendarId}`),
      ),
    [allDayOccurrencesRaw, visibleCalendarKeys],
  );
  const groupedAllDayOccurrences = useMemo(
    () => groupDuplicateAllDayOccurrences(visibleAllDayOccurrences),
    [visibleAllDayOccurrences],
  );

  // パネルごとに、その N 日ぶんのインデックス [0, dayCount-1] にクリップした区間で
  // packDayBars する。行の割り当てはここで確定するが、「何行まで見せるか
  // (sharedVisibleRows)」は3パネル分の最大行数を見てから決めるため、この時点では
  // 行を絞り込まない
  const rawAllDayPanels = useMemo(
    () =>
      panelStarts.map((panelStart) => {
        const panelEndDate = panelStart.add({ days: dayCount - 1 });
        const relevant = groupedAllDayOccurrences.filter((g) => {
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
    [panelStarts, dayCount, groupedAllDayOccurrences],
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
  // v1 はタスクリストの表示 ON/OFF が無いため取得済み全タスクを表示する(TODO: カレンダーと同様のトグル対応)
  const tasksRaw = useTasks(taskStore, allDayFromDate, allDayToDate);

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
    (updated: Occurrence) => {
      // ロールバック用に更新前のスナップショットを取ってから、楽観的・同期に
      // store を即座に更新して見た目に反映する
      const previous = store.get(updated.id);
      store.update(updated);
      // 永続化は非同期・fire-and-forget(App 側が db 書き込み・Google 書き戻しを担当)
      onPersist(updated, previous);
    },
    [store, onPersist],
  );

  const transform = transformForPhase(phase);
  const stripStyle = {
    transform,
    transition: instant ? "none" : `transform ${SLIDE_MS}ms ease`,
  };
  // 7列固定だった grid-template-columns を dayCount 列へ一般化する(WeekGrid.css 側は
  // repeat(7, 1fr) をフォールバック値として残してあるが、常にこのインライン値で上書きする)
  const panelColumnsStyle = { gridTemplateColumns: `repeat(${dayCount}, 1fr)` };

  return (
    <div className="week-grid">
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
                  {dayLayouts.map(({ visibleGroups, overflowCount }, dayIndex) => (
                    // eslint-disable-next-line react/no-array-index-key -- 列の並びは固定(dayCount ぶんの日付インデックス、タスクレーンと同じ流儀)
                    <GitHubLane
                      key={dayIndex}
                      groups={visibleGroups}
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

          <div className="week-grid-days-viewport">
            <div className="week-grid-days-strip" style={stripStyle}>
              {weekPanels.map(({ panelStart, dayStarts, dayEnds, dayData }, panelIndex) => (
                <div
                  className="week-grid-days-panel"
                  key={panelStart.toString()}
                  style={panelColumnsStyle}
                >
                  {dayData.map(({ day, positioned }, dayIndex) => (
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
                      calendarLookup={calendarLookup}
                      writeTarget={writeTarget}
                      onCreateEvent={onCreateEvent}
                      longPressCreate={longPressCreate}
                      activityClusters={activityPanels[panelIndex].dayClusters[dayIndex]}
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
