import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import {
  DB_VERSION,
  getHiddenTaskLists,
  getOrCreateDeviceId,
  setHiddenTaskLists,
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
