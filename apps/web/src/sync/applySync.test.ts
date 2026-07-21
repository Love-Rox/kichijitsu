import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import type { GoogleEventDTO, SyncResponse } from "@kichijitsu/shared";
import { DB_VERSION, upgradeKichijitsuSchema } from "../db/database";
import type { KichijitsuDB } from "../db/database";
import { applySyncResponse } from "./applySync";
import { OccurrenceStore } from "../store/occurrenceStore";
import { AllDayStore } from "../store/allDayStore";
import type { Occurrence } from "../model/types";
import type { EventSeries } from "../model/series";

/**
 * 全同期(isFullSync)適用のアトミック性テスト (2026-07-21)。
 *
 * fake-indexeddb で実際の IndexedDB トランザクション機構を動かし、
 * applySyncResponse の isFullSync 分岐が「削除 → 再投入」を単一トランザクションで
 * 行うこと(= 途中で失敗すれば削除ぶんも巻き戻ること)を検証する。
 * openKichijitsuDB() はプロセス内で1接続に メモ化される(本番用のシングルトン)ため、
 * テストごとに openDB() を直接呼んで独立した DB インスタンスを作る
 * (upgradeKichijitsuSchema はスキーマ定義を database.ts と共有する)。
 */

let dbCounter = 0;

async function openTestDB(): Promise<IDBPDatabase<KichijitsuDB>> {
  dbCounter += 1;
  return openDB<KichijitsuDB>(`applySync-test-${dbCounter}`, DB_VERSION, {
    upgrade: upgradeKichijitsuSchema,
  });
}

function baseEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: "evt-new",
    status: "confirmed",
    summary: "新しい予定",
    start: { dateTime: "2026-07-21T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-07-21T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    ...overrides,
  };
}

const ACCOUNT_ID = "acc-1";
const CALENDAR_ID = "cal-1";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applySyncResponse (isFullSync) のアトミック性", () => {
  it("既存 google データの削除と新データの投入が両方反映される(正常系)", async () => {
    const db = await openTestDB();

    // 対象 (accountId, calendarId) の既存 google occurrence(サーバーの応答にはもう
    // 含まれない = 全同期で消えるべきもの)
    const staleOccurrence: Occurrence = {
      id: "g:acc-1:cal-1:evt-stale",
      seriesId: null,
      title: "古い予定",
      startMs: 0,
      endMs: 1000,
      color: "#000",
      source: "google",
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
    };
    await db.put("occurrences", staleOccurrence);

    const store = new OccurrenceStore();
    const allDayStore = new AllDayStore();
    const res: SyncResponse = { isFullSync: true, events: [baseEvent()] };

    await applySyncResponse(db, store, allDayStore, res, {
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
    });

    const remaining = await db.getAll("occurrences");
    expect(remaining.find((o) => o.id === staleOccurrence.id)).toBeUndefined();
    expect(remaining.find((o) => o.id === "g:acc-1:cal-1:evt-new")).toBeDefined();
  });

  it("他アカウント/他カレンダーの google データは全同期の対象にならない", async () => {
    const db = await openTestDB();

    const otherAccountOccurrence: Occurrence = {
      id: "g:acc-2:cal-9:evt-other",
      seriesId: null,
      title: "別アカウントの予定",
      startMs: 0,
      endMs: 1000,
      color: "#000",
      source: "google",
      accountId: "acc-2",
      calendarId: "cal-9",
    };
    await db.put("occurrences", otherAccountOccurrence);

    const store = new OccurrenceStore();
    const allDayStore = new AllDayStore();
    const res: SyncResponse = { isFullSync: true, events: [baseEvent()] };

    await applySyncResponse(db, store, allDayStore, res, {
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
    });

    const remaining = await db.getAll("occurrences");
    expect(remaining.find((o) => o.id === otherAccountOccurrence.id)).toBeDefined();
  });

  it("投入(put)が途中で失敗すると、削除も含めてトランザクション全体がロールバックされる", async () => {
    const db = await openTestDB();

    // 削除されるはずの既存データ
    const staleSeries: EventSeries = {
      id: "g:acc-1:cal-1:series-stale",
      title: "古いシリーズ",
      color: "#000",
      source: "google",
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
      dtstartIso: "2026-07-01T10:00",
      timeZone: "Asia/Tokyo",
      durationMin: 60,
      rrule: "FREQ=DAILY",
      exdatesMs: [],
    };
    await db.put("series", staleSeries);
    const staleOccurrence: Occurrence = {
      id: "g:acc-1:cal-1:evt-stale",
      seriesId: null,
      title: "古い予定",
      startMs: 0,
      endMs: 1000,
      color: "#000",
      source: "google",
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
    };
    await db.put("occurrences", staleOccurrence);

    // 新規に put されるはずのイベントの id を先読みし、その id への put() を
    // 強制的に ConstraintError (add() の重複キー) に差し替えて「put 失敗」を再現する。
    // (通常は put() が overwrite するだけで失敗しないため、意図的な失敗注入が必要)
    const willFailId = "g:acc-1:cal-1:evt-new";
    await db.put("occurrences", {
      id: "__decoy__",
      seriesId: null,
      title: "衝突させるためのダミー",
      startMs: 0,
      endMs: 1,
      color: "#000",
      source: "local",
    } satisfies Occurrence);

    // 差し替え前の本物の put をこの時点で退避しておく(spyOn 後は prototype.put 自体が
    // このモックに置き換わるため、後から参照すると自分自身を無限に呼び出してしまう)。
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 後段で必ず .call(this, ...) するので束縛は問題ない
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (
          this.name === "occurrences" &&
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          (value as { id: unknown }).id === willFailId
        ) {
          // 既存の "__decoy__" と同じキーで add() することで、本物の ConstraintError
          // (request レベルの非同期エラー) を発生させる — これは tx を中断させ、
          // 同一トランザクション内の他の操作(削除含む)も丸ごとロールバックする
          return this.add({ ...(value as object), id: "__decoy__" });
        }
        return originalPut.call(this, value, key);
      });

    try {
      const store = new OccurrenceStore();
      const allDayStore = new AllDayStore();
      const res: SyncResponse = { isFullSync: true, events: [baseEvent({ id: "evt-new" })] };

      await expect(
        applySyncResponse(db, store, allDayStore, res, {
          accountId: ACCOUNT_ID,
          calendarId: CALENDAR_ID,
        }),
      ).rejects.toBeTruthy();
    } finally {
      putSpy.mockRestore();
    }

    // ロールバック確認: 削除されるはずだった古いデータが手つかずのまま残っている
    const remainingSeries = await db.getAll("series");
    expect(remainingSeries.find((s) => s.id === staleSeries.id)).toBeDefined();
    const remainingOccurrences = await db.getAll("occurrences");
    expect(remainingOccurrences.find((o) => o.id === staleOccurrence.id)).toBeDefined();
    // 新データも(put が失敗した以上)反映されていない
    expect(remainingOccurrences.find((o) => o.id === willFailId)).toBeUndefined();
    // decoy 自体も変化していない
    expect(remainingOccurrences.find((o) => o.id === "__decoy__")?.title).toBe(
      "衝突させるためのダミー",
    );
  });
});
