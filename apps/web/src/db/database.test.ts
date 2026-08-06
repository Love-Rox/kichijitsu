import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import {
  clearLogoutTargetStores,
  CURRENT_SYNC_BACKFILL_VERSION,
  DB_VERSION,
  getDeclinedVisibilitySettings,
  getHiddenTaskLists,
  getOrCreateDeviceId,
  getSyncBackfillVersion,
  LOGOUT_CLEARED_STORES,
  LOGOUT_KEPT_STORES,
  setDeclinedVisibilitySettings,
  setHiddenTaskLists,
  setSyncBackfillVersion,
  upgradeKichijitsuSchema,
} from "./database";
import type { KichijitsuDB } from "./database";

/**
 * getOrCreateDeviceId (端末ごと syncToken、2026-07-21) のテスト。openKichijitsuDB() は
 * プロセス内で1接続にメモ化されるため、applySync.test.ts と同じ流儀でテストごとに
 * openDB() を直接呼んで独立した DB インスタンスを作る。
 */

let dbCounter = 0;

async function openTestDB(): Promise<IDBPDatabase<KichijitsuDB>> {
  dbCounter += 1;
  return openDB<KichijitsuDB>(`deviceId-test-${dbCounter}`, DB_VERSION, {
    upgrade: upgradeKichijitsuSchema,
  });
}

describe("getOrCreateDeviceId", () => {
  it("未保存なら新しい UUID を生成して meta ストアに保存する", async () => {
    const db = await openTestDB();

    const id = await getOrCreateDeviceId(db);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(db.get("meta", "deviceId")).resolves.toBe(id);
  });

  it("既に保存済みならその値をそのまま返す(再生成しない)", async () => {
    const db = await openTestDB();

    const first = await getOrCreateDeviceId(db);
    const second = await getOrCreateDeviceId(db);

    expect(second).toBe(first);
  });

  it("meta ストアに既存値があればそれを使う(新規 openDB 越しでも永続化されている)", async () => {
    const db = await openTestDB();
    await db.put("meta", "existing-device-id", "deviceId");

    const id = await getOrCreateDeviceId(db);

    expect(id).toBe("existing-device-id");
  });
});

/**
 * タスクリスト表示 ON/OFF (左ペイン増分2、2026-07-22) の永続化。visibleCalendars とは逆に
 * 「明示的に OFF にしたリストの集合」を保存する設計(database.ts の getHiddenTaskLists
 * コメント参照) ―― 未保存 = 空集合 = 全 ON がデフォルトになることをここで確認する。
 */
describe("getHiddenTaskLists / setHiddenTaskLists", () => {
  it("未保存なら空集合を返す(デフォルト全 ON)", async () => {
    const db = await openTestDB();

    const hidden = await getHiddenTaskLists(db);

    expect(hidden.size).toBe(0);
  });

  it("保存した集合をそのまま読み戻す", async () => {
    const db = await openTestDB();

    await setHiddenTaskLists(db, new Set(["acc-1:list-1", "acc-1:list-2"]));
    const hidden = await getHiddenTaskLists(db);

    expect([...hidden].sort()).toEqual(["acc-1:list-1", "acc-1:list-2"]);
  });

  it("空集合で上書き保存すると全 ON に戻る", async () => {
    const db = await openTestDB();
    await setHiddenTaskLists(db, new Set(["acc-1:list-1"]));

    await setHiddenTaskLists(db, new Set());
    const hidden = await getHiddenTaskLists(db);

    expect(hidden.size).toBe(0);
  });
});

/**
 * 「不参加を表示」設定 (参加ステータス表示、2026-07-22) の永続化。hiddenTaskLists と同じ
 * 流儀(この端末だけのローカル設定)。未保存時は DEFAULT_DECLINED_VISIBILITY
 * (showDeclined: true = 現状維持) を返すことをここで確認する。
 */
describe("getDeclinedVisibilitySettings / setDeclinedVisibilitySettings", () => {
  it("未保存なら既定値 (showDeclined: true, keepOrganizerDeclined: true) を返す", async () => {
    const db = await openTestDB();

    const settings = await getDeclinedVisibilitySettings(db);

    expect(settings).toEqual({ showDeclined: true, keepOrganizerDeclined: true });
  });

  it("保存した設定をそのまま読み戻す", async () => {
    const db = await openTestDB();

    await setDeclinedVisibilitySettings(db, {
      showDeclined: false,
      keepOrganizerDeclined: false,
    });
    const settings = await getDeclinedVisibilitySettings(db);

    expect(settings).toEqual({ showDeclined: false, keepOrganizerDeclined: false });
  });
});

/**
 * 同期バックフィル世代 (2026-07-22、旧 oooBackfillDone boolean からの一般化)。
 * getSyncBackfillVersion の移行判定 (旧キー true → 1) が本体 ―― これが無いと、数値版導入前に
 * eventType バックフィルを済ませていた既存ユーザーが、デプロイ後に eventType から
 * もう一度やり直させられてしまう。
 */
describe("getSyncBackfillVersion / setSyncBackfillVersion (旧 oooBackfillDone からの移行)", () => {
  it("何も保存されていなければ 0 を返す(未実施)", async () => {
    const db = await openTestDB();

    expect(await getSyncBackfillVersion(db)).toBe(0);
  });

  it("旧キー oooBackfillDone===true が保存されていれば 1 を返す(eventType バックフィルまでは完了済みとみなす)", async () => {
    const db = await openTestDB();
    await db.put("meta", true, "oooBackfillDone");

    expect(await getSyncBackfillVersion(db)).toBe(1);
  });

  it("旧キーが false/未設定なら移行しない(0 のまま)", async () => {
    const db = await openTestDB();
    await db.put("meta", false, "oooBackfillDone");

    expect(await getSyncBackfillVersion(db)).toBe(0);
  });

  it("新キー (syncBackfillVersion) が保存されていればそちらを優先し、旧キーは見ない", async () => {
    const db = await openTestDB();
    await db.put("meta", true, "oooBackfillDone"); // 旧キーもあるが無視される
    await setSyncBackfillVersion(db, 2);

    expect(await getSyncBackfillVersion(db)).toBe(2);
  });

  it("setSyncBackfillVersion で保存した世代をそのまま読み戻す", async () => {
    const db = await openTestDB();

    await setSyncBackfillVersion(db, CURRENT_SYNC_BACKFILL_VERSION);

    expect(await getSyncBackfillVersion(db)).toBe(CURRENT_SYNC_BACKFILL_VERSION);
  });
});

/**
 * ログアウト時の端末データ削除 (2026-08-06) が対象ストアを分類する LOGOUT_CLEARED_STORES /
 * LOGOUT_KEPT_STORES。**「実際のストア一覧と食い違ったら気付ける」ことがこのテストの本体**
 * ―― upgradeKichijitsuSchema にストアを足したのにどちらの配列にも入れ忘れると、
 * database.ts 側の型チェックだけでなくここも落ちる(型チェックは KichijitsuDB インターフェース
 * の更新漏れには効かないため、実際に作られたストア一覧との突き合わせを別途持つ)。
 */
describe("LOGOUT_CLEARED_STORES / LOGOUT_KEPT_STORES", () => {
  it("2つの配列を合わせると、実際に作られる全ストアと過不足なく一致する", async () => {
    const db = await openTestDB();

    const actualStoreNames = [...db.objectStoreNames].toSorted();
    const classifiedStoreNames = [...LOGOUT_CLEARED_STORES, ...LOGOUT_KEPT_STORES].toSorted();

    expect(classifiedStoreNames).toEqual(actualStoreNames);
  });

  it("消す側と残す側で重複が無い(同じストアが両方に分類されていない)", () => {
    // 2つの配列は分類上まったく重ならない文字列リテラルユニオンなので、Set<string> に
    // widen してから見比べる(Set<T>.has は T のままだと型上そもそも重ならない前提になる)
    const clearedSet = new Set<string>(LOGOUT_CLEARED_STORES);
    const overlap = LOGOUT_KEPT_STORES.filter((name: string) => clearedSet.has(name));

    expect(overlap).toEqual([]);
  });

  it("残す側は plannedBlocks/timeEntries だけ(サーバーに対応が無いローカル専用ストア)", () => {
    // 明示列挙で固定しているのはここだけ ―― LOGOUT_KEPT_STORES 自体を明示列挙にすると
    // 「新しいローカル専用ストアを足したのに消す側に紛れ込む」事故を検知できないため、
    // このテストは「残す側に *予期しないもの* が増えていないか」の見張り役として書く
    // (増やす判断そのものは PR レビューで人が見る)。
    expect([...LOGOUT_KEPT_STORES].toSorted()).toEqual(["plannedBlocks", "timeEntries"]);
  });
});

describe("clearLogoutTargetStores", () => {
  it("LOGOUT_CLEARED_STORES だけを空にし、LOGOUT_KEPT_STORES (plannedBlocks/timeEntries) には触れない", async () => {
    const db = await openTestDB();

    await db.put("occurrences", {
      id: "o1",
      seriesId: null,
      title: "会議",
      startMs: 0,
      endMs: 1,
      color: "#000",
      source: "google",
    });
    await db.put("allDayOccurrences", {
      id: "a1",
      seriesId: null,
      title: "終日",
      startDate: "2026-08-06",
      endDate: "2026-08-07",
      color: "#000",
      source: "google",
    });
    await db.put("tasks", {
      id: "t1",
      accountId: "acc1",
      taskListId: "list1",
      title: "タスク",
      dueDate: null,
      status: "needsAction",
    });
    await db.put("series", {
      id: "s1",
      title: "繰り返し",
      color: "#000",
      source: "google",
      dtstartIso: "2026-08-06T10:00",
      timeZone: "Asia/Tokyo",
      durationMin: 30,
      rrule: "FREQ=WEEKLY;BYDAY=TH",
      exdatesMs: [],
    });
    await db.put("overrides", { id: "s1:0", seriesId: "s1", originalStartMs: 0, patch: {} });
    await db.put("githubItems", {
      id: "g1",
      type: "issue",
      title: "issue",
      dateMs: 0,
      repo: "o/r",
      number: 1,
      url: "https://example.com",
    });
    await db.put("meta", "device-1", "deviceId");
    await db.put("plannedBlocks", {
      id: "p1",
      startMs: 0,
      endMs: 1,
      linkedItemId: "ghq:o/r:issue:1",
      itemType: "issue",
      title: "block",
      repo: "o/r",
      number: 1,
      url: "https://example.com",
    });
    await db.put("timeEntries", {
      id: "e1",
      linkedItemId: "ghq:o/r:issue:1",
      itemType: "issue",
      title: "entry",
      repo: "o/r",
      number: 1,
      url: "https://example.com",
      startMs: 0,
      endMs: null,
    });

    await clearLogoutTargetStores(db);

    for (const name of LOGOUT_CLEARED_STORES) {
      expect(await db.count(name)).toBe(0);
    }
    // plannedBlocks/timeEntries はこの端末にしか無いデータなので残る
    expect(await db.count("plannedBlocks")).toBe(1);
    expect(await db.count("timeEntries")).toBe(1);
  });

  it("何も入っていなくても例外を投げない(初回ログイン直後のログアウト等)", async () => {
    const db = await openTestDB();

    await expect(clearLogoutTargetStores(db)).resolves.toBeUndefined();
  });
});
