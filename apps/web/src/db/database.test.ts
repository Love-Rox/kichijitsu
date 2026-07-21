import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import { openDB } from "idb";
import type { IDBPDatabase } from "idb";
import { DB_VERSION, getOrCreateDeviceId, upgradeKichijitsuSchema } from "./database";
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
