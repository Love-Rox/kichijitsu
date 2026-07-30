import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type {
  AllDayOccurrence,
  GitHubItem,
  Occurrence,
  PlannedBlock,
  TaskItem,
} from "../model/types";
import { AllDayStore } from "../store/allDayStore";
import { GitHubStore } from "../store/githubStore";
import { OccurrenceStore } from "../store/occurrenceStore";
import { PlannedStore } from "../store/plannedStore";
import { TaskStore } from "../store/taskStore";
import { DEFAULT_DECLINED_VISIBILITY } from "../sync/declinedVisibility";
import { expandSeries } from "../expansion/expandSeries";
import { decideExpansionWindow } from "../expansion/windowPolicy";
import { bootstrapDatabase, type BootstrapOptions } from "./bootstrap";
import {
  DB_VERSION,
  deleteOccurrencesByIds,
  getAllOccurrences,
  getAllOverrides,
  getAllSeries,
  getExpansionState,
  putAllDayOccurrences,
  putGitHubItems,
  putOccurrences,
  putOverride,
  putPlannedBlock,
  putSeries,
  putTasks,
  setDeclinedVisibilitySettings,
  setExpansionState,
  setHiddenTaskLists,
  setVisibleCalendars,
  upgradeKichijitsuSchema,
  type KichijitsuDB,
} from "./database";

/**
 * 起動時の IndexedDB 読み込みシーケンス (db/bootstrap.ts) のテスト。
 *
 * db/database.test.ts と同じ流儀で、openKichijitsuDB() のメモ化を避けるためテストごとに
 * openDB() で独立した DB を作り、bootstrapDatabase には openDatabase としてそれを渡す。
 * ensureExpanded は Worker を起こすので、expand も no-op のスパイに差し替える
 * (このテストで検証したいのは「何をどの順で読み、どう通知するか」の配線であり、
 * 展開そのものは expansion/ 側のテストの持ち分)。
 */

let dbCounter = 0;

async function openTestDB(): Promise<IDBPDatabase<KichijitsuDB>> {
  dbCounter += 1;
  return openDB<KichijitsuDB>(`bootstrap-test-${dbCounter}`, DB_VERSION, {
    upgrade: upgradeKichijitsuSchema,
  });
}

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 6, 25, 0, 0, 0);

function occurrence(id: string, overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id,
    seriesId: null,
    title: id,
    startMs: BASE_MS + HOUR_MS,
    endMs: BASE_MS + 2 * HOUR_MS,
    color: "#000000",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

const ALL_DAY: AllDayOccurrence = {
  id: "allday-1",
  seriesId: null,
  title: "終日",
  startDate: "2026-07-25",
  endDate: "2026-07-25",
  color: "#111111",
  source: "google",
  accountId: "acc-1",
  calendarId: "cal-1",
};

const TASK: TaskItem = {
  id: "task-1",
  accountId: "acc-1",
  taskListId: "list-1",
  title: "タスク",
  dueDate: "2026-07-25",
  status: "needsAction",
};

const GITHUB_ITEM: GitHubItem = {
  id: "gh-1",
  type: "issue",
  title: "issue",
  dateMs: BASE_MS,
  repo: "Love-Rox/kichijitsu",
  number: 1,
  url: "https://example.invalid/1",
};

const PLANNED: PlannedBlock = {
  id: "planned-1",
  startMs: BASE_MS,
  endMs: BASE_MS + HOUR_MS,
  linkedItemId: "gh-1",
  itemType: "issue",
  title: "issue",
  repo: "Love-Rox/kichijitsu",
  number: 1,
  url: "https://example.invalid/1",
};

/** テスト用の呼び出し記録つきオプション一式(必要なものだけ上書きして使う) */
function setup(
  db: IDBPDatabase<KichijitsuDB>,
  overrides: Partial<BootstrapOptions> = {},
): {
  options: BootstrapOptions;
  stores: {
    store: OccurrenceStore;
    allDayStore: AllDayStore;
    taskStore: TaskStore;
    githubStore: GitHubStore;
    plannedStore: PlannedStore;
  };
  calls: {
    deviceIds: string[];
    visibleCalendars: unknown[];
    hiddenTaskLists: ReadonlySet<string>[];
    declinedVisibility: unknown[];
    ready: number;
    expand: { fromMs: number; toMs: number }[];
    reexpand: number;
  };
} {
  const stores = {
    store: new OccurrenceStore(),
    allDayStore: new AllDayStore(),
    taskStore: new TaskStore(),
    githubStore: new GitHubStore(),
    plannedStore: new PlannedStore(),
  };
  const calls = {
    deviceIds: [] as string[],
    visibleCalendars: [] as unknown[],
    hiddenTaskLists: [] as ReadonlySet<string>[],
    declinedVisibility: [] as unknown[],
    ready: 0,
    expand: [] as { fromMs: number; toMs: number }[],
    reexpand: 0,
  };
  const options: BootstrapOptions = {
    stores,
    initialRange: { fromMs: BASE_MS, toMs: BASE_MS + 24 * HOUR_MS },
    timeZone: "Asia/Tokyo",
    demoSeedEnabled: false,
    isCancelled: () => false,
    onDeviceId: (id) => calls.deviceIds.push(id),
    onVisibleCalendars: (v) => calls.visibleCalendars.push(v),
    onHiddenTaskLists: (v) => calls.hiddenTaskLists.push(v),
    onDeclinedVisibility: (v) => calls.declinedVisibility.push(v),
    onReady: () => {
      calls.ready += 1;
    },
    openDatabase: async () => db,
    expand: async (_db, _store, fromMs, toMs) => {
      calls.expand.push({ fromMs, toMs });
    },
    reexpand: async () => {
      calls.reexpand += 1;
    },
    ...overrides,
  };
  return { options, stores, calls };
}

/**
 * expansion/ensureExpanded の **DB 側の手順だけを写した最小版** (expand / reexpand の組)。
 *
 * 本物は Worker を起こすのでこのテストには乗らない(ファイル冒頭のコメント参照)が、
 * 「?demo=1 をリロードしても繰り返し予定が出るか」は展開結果が IndexedDB とストアに載る
 * ところまで通さないと確かめられない ―― なので純関数の expandSeries を直接呼ぶ版を置く。
 * ウィンドウの決め方も本物と同じ decideExpansionWindow を使う。
 */
function makeRealisticExpanders(): Pick<BootstrapOptions, "expand" | "reexpand"> {
  const expandInto = async (
    db: IDBPDatabase<KichijitsuDB>,
    store: OccurrenceStore,
    fromMs: number,
    toMs: number,
    dropStale: boolean,
  ): Promise<void> => {
    const [series, overrides] = await Promise.all([getAllSeries(db), getAllOverrides(db)]);
    if (dropStale) {
      const seriesIds = new Set(series.map((s) => s.id));
      const existing = await getAllOccurrences(db);
      await deleteOccurrencesByIds(
        db,
        existing.filter((o) => o.seriesId !== null && seriesIds.has(o.seriesId)).map((o) => o.id),
      );
    }
    const overridesBySeriesId = new Map(
      series.map((s) => [s.id, overrides.filter((o) => o.seriesId === s.id)]),
    );
    const expanded = series.flatMap((s) =>
      expandSeries({
        series: s,
        overrides: overridesBySeriesId.get(s.id) ?? [],
        windowStartMs: fromMs,
        windowEndMs: toMs,
      }),
    );
    await putOccurrences(db, expanded);
    store.load(expanded);
  };

  return {
    expand: async (db, store, fromMs, toMs) => {
      const state = await getExpansionState(db);
      const decision = decideExpansionWindow(fromMs, toMs, state, Date.now());
      if (!decision.needsExpand) return;
      await expandInto(db, store, decision.fromMs, decision.toMs, false);
      await setExpansionState(db, {
        expandedFromMs: decision.fromMs,
        expandedToMs: decision.toMs,
      });
    },
    reexpand: async (db, store) => {
      const state = await getExpansionState(db);
      if (!state) return;
      await expandInto(db, store, state.expandedFromMs, state.expandedToMs, true);
    },
  };
}

describe("bootstrapDatabase", () => {
  it("deviceId・表示設定・各ストアへの初回反映を経て onReady に到達する", async () => {
    const db = await openTestDB();
    await setExpansionState(db, {
      expandedFromMs: BASE_MS - 24 * HOUR_MS,
      expandedToMs: BASE_MS + 48 * HOUR_MS,
    });
    await putOccurrences(db, [occurrence("occ-1")]);
    await putAllDayOccurrences(db, [ALL_DAY]);
    await putTasks(db, [TASK]);
    await putGitHubItems(db, [GITHUB_ITEM]);
    await putPlannedBlock(db, PLANNED);
    await setVisibleCalendars(db, { "acc-1": ["cal-1"] });
    await setHiddenTaskLists(db, new Set(["acc-1:list-9"]));
    await setDeclinedVisibilitySettings(db, {
      showDeclined: false,
      keepOrganizerDeclined: true,
    });

    const { options, stores, calls } = setup(db);
    await bootstrapDatabase(options);

    // deviceId は DB を開いた直後に確定する(POST /api/sync が使う)
    expect(calls.deviceIds).toHaveLength(1);
    expect(calls.deviceIds[0]).toMatch(/^[0-9a-f-]{36}$/);

    // 5ストアすべてに反映されている
    expect(stores.store.get("occ-1")?.title).toBe("occ-1");
    expect(stores.allDayStore.get("allday-1")?.title).toBe("終日");
    expect(stores.taskStore.get("task-1")?.title).toBe("タスク");
    expect(stores.githubStore.getAll()).toHaveLength(1);
    expect(stores.plannedStore.getAll()).toHaveLength(1);

    // 表示設定はそのまま呼び出し側へ渡す(マージ等はしない)
    expect(calls.visibleCalendars).toEqual([{ "acc-1": ["cal-1"] }]);
    expect([...calls.hiddenTaskLists[0]]).toEqual(["acc-1:list-9"]);
    expect(calls.declinedVisibility).toEqual([
      { showDeclined: false, keepOrganizerDeclined: true },
    ]);

    expect(calls.ready).toBe(1);
  });

  it("表示設定が未保存なら既定値(空の選択・空の非表示集合・DEFAULT_DECLINED_VISIBILITY)を渡す", async () => {
    const db = await openTestDB();
    const { options, calls } = setup(db);

    await bootstrapDatabase(options);

    expect(calls.visibleCalendars).toEqual([{}]);
    expect([...calls.hiddenTaskLists[0]]).toEqual([]);
    expect(calls.declinedVisibility).toEqual([DEFAULT_DECLINED_VISIBILITY]);
  });

  it("初回反映は各ストア1回の通知にまとめられ、通知時点では5ストアすべてが埋まっている(初期描画のチラつき防止)", async () => {
    const db = await openTestDB();
    await setExpansionState(db, {
      expandedFromMs: BASE_MS - 24 * HOUR_MS,
      expandedToMs: BASE_MS + 48 * HOUR_MS,
    });
    await putOccurrences(db, [occurrence("occ-1")]);
    await putAllDayOccurrences(db, [ALL_DAY]);
    await putTasks(db, [TASK]);
    await putGitHubItems(db, [GITHUB_ITEM]);
    await putPlannedBlock(db, PLANNED);

    const { options, stores } = setup(db);

    // 通知のたびに「その瞬間、5ストアすべてにデータが入っているか」を記録する。
    // batch のネストを崩すと(例: store.load の直後に通知が飛ぶと)ここが false になる
    const snapshots: Record<string, boolean[]> = {
      store: [],
      allDay: [],
      task: [],
      github: [],
      planned: [],
    };
    const allLoaded = (): boolean =>
      stores.store.get("occ-1") !== undefined &&
      stores.allDayStore.get("allday-1") !== undefined &&
      stores.taskStore.get("task-1") !== undefined &&
      stores.githubStore.getAll().length === 1 &&
      stores.plannedStore.getAll().length === 1;
    stores.store.subscribe(() => snapshots.store.push(allLoaded()));
    stores.allDayStore.subscribe(() => snapshots.allDay.push(allLoaded()));
    stores.taskStore.subscribe(() => snapshots.task.push(allLoaded()));
    stores.githubStore.subscribe(() => snapshots.github.push(allLoaded()));
    stores.plannedStore.subscribe(() => snapshots.planned.push(allLoaded()));

    await bootstrapDatabase(options);

    for (const key of Object.keys(snapshots)) {
      expect(snapshots[key], `${key} の通知回数`).toEqual([true]);
    }
  });

  it("展開は渡された initialRange で1回だけ呼び、occurrences は保存済み ExpansionState の範囲で読む", async () => {
    const db = await openTestDB();
    await setExpansionState(db, {
      expandedFromMs: BASE_MS,
      expandedToMs: BASE_MS + 3 * HOUR_MS,
    });
    // ExpansionState の範囲内 / 範囲外(翌日)の2件を入れておく
    await putOccurrences(db, [
      occurrence("occ-in"),
      occurrence("occ-out", {
        startMs: BASE_MS + 30 * HOUR_MS,
        endMs: BASE_MS + 31 * HOUR_MS,
      }),
    ]);

    const { options, stores, calls } = setup(db);
    await bootstrapDatabase(options);

    expect(calls.expand).toEqual([{ fromMs: BASE_MS, toMs: BASE_MS + 24 * HOUR_MS }]);
    expect(stores.store.getAll().map((o) => o.id)).toEqual(["occ-in"]);
  });

  it("ExpansionState が無ければ occurrences は読み込まない(他のストアは全件ロードされる)", async () => {
    const db = await openTestDB();
    await putOccurrences(db, [occurrence("occ-1")]);
    await putAllDayOccurrences(db, [ALL_DAY]);

    const { options, stores } = setup(db);
    await bootstrapDatabase(options);

    expect(stores.store.getAll()).toEqual([]);
    expect(stores.allDayStore.get("allday-1")).toBeDefined();
  });

  it("最初からキャンセル済みなら deviceId も onReady も呼ばない", async () => {
    const db = await openTestDB();
    const { options, calls } = setup(db, { isCancelled: () => true });

    await bootstrapDatabase(options);

    expect(calls.deviceIds).toEqual([]);
    expect(calls.expand).toEqual([]);
    expect(calls.ready).toBe(0);
  });

  it("読み込み中にキャンセルされたらストアへの反映と onReady を行わない", async () => {
    const db = await openTestDB();
    await setExpansionState(db, {
      expandedFromMs: BASE_MS - 24 * HOUR_MS,
      expandedToMs: BASE_MS + 48 * HOUR_MS,
    });
    await putOccurrences(db, [occurrence("occ-1")]);
    await putAllDayOccurrences(db, [ALL_DAY]);

    let cancelled = false;
    const { options, stores, calls } = setup(db, {
      isCancelled: () => cancelled,
      // 展開まで進んだところでアンマウント相当にする
      expand: async () => {
        cancelled = true;
      },
    });

    await bootstrapDatabase(options);

    expect(stores.store.getAll()).toEqual([]);
    expect(stores.allDayStore.get("allday-1")).toBeUndefined();
    expect(calls.visibleCalendars).toEqual([]);
    expect(calls.ready).toBe(0);
  });

  it("demoSeedEnabled が false なら空の DB でもダミーを投入せず、強制再展開もしない", async () => {
    const db = await openTestDB();
    const { options, stores, calls } = setup(db);

    await bootstrapDatabase(options);

    await expect(db.count("series")).resolves.toBe(0);
    expect(stores.store.getAll()).toEqual([]);
    // 通常起動で毎回全 series を再展開するのは増分ポリシーの放棄なので、呼ばれてはいけない
    expect(calls.reexpand).toBe(0);
  });

  it("demoSeedEnabled が true なら毎起動でデモデータを入れ直し、そのつど強制再展開する", async () => {
    const db = await openTestDB();

    // 3回続けて起動する。cleanupDemoData が毎回消して、シードが毎回入れ直すので、
    // 件数は「初回だけ多い/2回目以降ゼロ」ではなく毎回同じでなければならない
    const counts: { series: number; overrides: number; occurrences: number; reexpand: number }[] =
      [];
    for (let i = 0; i < 3; i++) {
      const { options, calls } = setup(db, { demoSeedEnabled: true });
      await bootstrapDatabase(options);
      counts.push({
        series: await db.count("series"),
        overrides: await db.count("overrides"),
        occurrences: await db.count("occurrences"),
        reexpand: calls.reexpand,
      });
    }

    expect(counts[0].series).toBeGreaterThan(0);
    expect(counts[0].overrides).toBeGreaterThan(0);
    expect(counts[0].occurrences).toBeGreaterThan(0);
    // 起動のたびに1回だけ強制再展開する(シリーズ由来の occurrence を復活させるため)
    expect(counts.map((c) => c.reexpand)).toEqual([1, 1, 1]);
    // 3回とも同じ ―― 重複して増えることも、消えたままになることも無い
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[2]).toEqual(counts[0]);
  });

  it("?demo=1 の再起動でも繰り返し予定が毎回ストアに載る(初回起動だけ正常にならない)", async () => {
    const db = await openTestDB();

    // 展開を通す最小版を使い、シリーズ由来の occurrence が実際に IndexedDB とストアへ
    // 載るところまで確かめる(この回帰こそが 2026-07-30 のバグ本体)
    const seriesOccurrenceCounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { options, stores } = setup(db, {
        demoSeedEnabled: true,
        ...makeRealisticExpanders(),
      });
      await bootstrapDatabase(options);
      seriesOccurrenceCounts.push(stores.store.getAll().filter((o) => o.seriesId !== null).length);
    }

    expect(seriesOccurrenceCounts[0]).toBeGreaterThan(0);
    expect(seriesOccurrenceCounts[1]).toBe(seriesOccurrenceCounts[0]);
    expect(seriesOccurrenceCounts[2]).toBe(seriesOccurrenceCounts[0]);
  });

  it("デモで起動した後に通常起動すると、デモの残骸が1件も残らない", async () => {
    const db = await openTestDB();

    // ?demo=1 で起動(展開まで通すので、シリーズ由来の occurrence も DB に入る)
    await bootstrapDatabase(
      setup(db, { demoSeedEnabled: true, ...makeRealisticExpanders() }).options,
    );
    expect(await db.count("series")).toBeGreaterThan(0);
    expect((await getAllOccurrences(db)).filter((o) => o.seriesId !== null).length).toBeGreaterThan(
      0,
    );

    // 実データを1件混ぜてから ?demo=1 なしで起動する ―― デモだけが消え、実データは残ること
    await putOccurrences(db, [occurrence("g:acc-1:cal-1:keep")]);
    await bootstrapDatabase(setup(db, { ...makeRealisticExpanders() }).options);

    await expect(db.count("series")).resolves.toBe(0);
    await expect(db.count("overrides")).resolves.toBe(0);
    expect((await getAllOccurrences(db)).map((o) => o.id)).toEqual(["g:acc-1:cal-1:keep"]);
  });

  it("過去にシードされたデモデータの残骸は通常起動で掃除される(冪等)", async () => {
    const db = await openTestDB();
    await putSeries(db, [
      {
        id: "series-standup",
        title: "デモ",
        dtstartIso: "2026-06-15T10:00",
        timeZone: "Asia/Tokyo",
        durationMin: 60,
        rrule: "FREQ=WEEKLY",
        exdatesMs: [],
        color: "#222222",
        source: "local",
      },
    ]);
    await putOverride(db, {
      id: "series-standup:1",
      seriesId: "series-standup",
      originalStartMs: BASE_MS,
      patch: { title: "変更" },
    });
    await putOccurrences(db, [
      occurrence("dummy-2026-07-25-0", { source: "local" }),
      occurrence("series-standup:100", { seriesId: "series-standup", source: "local" }),
      occurrence("g:acc-1:cal-1:keep"),
    ]);

    const { options } = setup(db);
    await bootstrapDatabase(options);

    await expect(db.count("series")).resolves.toBe(0);
    await expect(db.count("overrides")).resolves.toBe(0);
    const remaining = await db.getAll("occurrences");
    expect(remaining.map((o) => o.id)).toEqual(["g:acc-1:cal-1:keep"]);

    // 2回目は何も消すものが無い(冪等)
    await bootstrapDatabase(setup(db).options);
    await expect(db.count("occurrences")).resolves.toBe(1);
  });

  it("ID スコープ化以前のレガシー Google データ(accountId 無し)も掃除される", async () => {
    const db = await openTestDB();
    await putOccurrences(db, [
      occurrence("g:legacy", { accountId: undefined, calendarId: undefined }),
      occurrence("g:acc-1:cal-1:keep"),
    ]);

    const { options } = setup(db);
    await bootstrapDatabase(options);

    const remaining = await db.getAll("occurrences");
    expect(remaining.map((o) => o.id)).toEqual(["g:acc-1:cal-1:keep"]);
  });
});
