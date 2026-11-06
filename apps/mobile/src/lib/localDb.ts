import * as SQLite from "expo-sqlite";
import type { EventSeries, InstanceOverride } from "@kichijitsu/web/model/series";
import type { AllDayOccurrence, Occurrence } from "@kichijitsu/web/model/types";
import type { MappedSync } from "@kichijitsu/web/sync/mapGoogle";

/**
 * 手元への保存 (ローカルファースト)。Web 版の IndexedDB と同じく、**変換済み**の予定
 * (mapGoogleEvents の結果: 単発・終日・繰り返しの親・例外インスタンス) を保存する。
 * 差分の適用規則は Web の applySyncResponse (apps/web/src/sync/applySync.ts) と同じ:
 *  - 全同期 (isFullSync): そのカレンダーの既存データを消して入れ直す(他のカレンダーは触らない)
 *  - 差分: 繰り返しの親の削除 → put → 単発/終日の削除、の順
 * 繰り返しの展開は保存せず、表示のたびに行う(展開結果は保存しない)。
 */
export interface Partition {
  singles: Occurrence[];
  allDays: AllDayOccurrence[];
  series: EventSeries[];
  overrides: InstanceOverride[];
}

export const calKey = (accountId: string, calendarId: string) => `${accountId}\u0000${calendarId}`;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync("kichijitsu.db");
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS singles (
        id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS singles_cal ON singles (account_id, calendar_id);
      CREATE TABLE IF NOT EXISTS all_days (
        id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS all_days_cal ON all_days (account_id, calendar_id);
      CREATE TABLE IF NOT EXISTS series (
        id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, calendar_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS series_cal ON series (account_id, calendar_id);
      CREATE TABLE IF NOT EXISTS overrides (
        id TEXT PRIMARY KEY NOT NULL, series_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS overrides_series ON overrides (series_id);
    `);
    return db;
  })();
  return dbPromise;
}

// ---- meta ----
export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
}

/** 端末ごとの同期位置をサーバーが覚えるための、この端末の固定の ID。 */
export async function getDeviceId(): Promise<string> {
  const existing = await getMeta("deviceId");
  if (existing) return existing;
  const id = `mobile-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await setMeta("deviceId", id);
  return id;
}

// ---- 読み出し ----
function parseRows<T>(rows: { json: string }[]): T[] {
  return rows.map((r) => JSON.parse(r.json) as T);
}

/** 保存済みの全カレンダーぶんを、カレンダーごとに分けて読む。 */
export async function readAll(): Promise<Map<string, Partition>> {
  const db = await getDb();
  const [singles, allDays, series, overrides] = await Promise.all([
    db.getAllAsync<{ account_id: string; calendar_id: string; json: string }>(
      "SELECT account_id, calendar_id, json FROM singles",
    ),
    db.getAllAsync<{ account_id: string; calendar_id: string; json: string }>(
      "SELECT account_id, calendar_id, json FROM all_days",
    ),
    db.getAllAsync<{ id: string; account_id: string; calendar_id: string; json: string }>(
      "SELECT id, account_id, calendar_id, json FROM series",
    ),
    db.getAllAsync<{ series_id: string; json: string }>("SELECT series_id, json FROM overrides"),
  ]);

  const out = new Map<string, Partition>();
  const part = (key: string): Partition => {
    let p = out.get(key);
    if (!p) out.set(key, (p = { singles: [], allDays: [], series: [], overrides: [] }));
    return p;
  };
  for (const r of singles) part(calKey(r.account_id, r.calendar_id)).singles.push(JSON.parse(r.json));
  for (const r of allDays) part(calKey(r.account_id, r.calendar_id)).allDays.push(JSON.parse(r.json));
  const seriesCal = new Map<string, string>();
  for (const r of series) {
    const key = calKey(r.account_id, r.calendar_id);
    seriesCal.set(r.id, key);
    part(key).series.push(JSON.parse(r.json));
  }
  for (const r of overrides) {
    const key = seriesCal.get(r.series_id);
    if (key) part(key).overrides.push(JSON.parse(r.json));
  }
  return out;
}

/** 1 カレンダーぶんだけを読む(同期の適用後に、そのカレンダーだけ入れ替えるため)。 */
export async function readPartition(accountId: string, calendarId: string): Promise<Partition> {
  const db = await getDb();
  const [singles, allDays, series, overrides] = await Promise.all([
    db.getAllAsync<{ json: string }>(
      "SELECT json FROM singles WHERE account_id = ? AND calendar_id = ?",
      accountId,
      calendarId,
    ),
    db.getAllAsync<{ json: string }>(
      "SELECT json FROM all_days WHERE account_id = ? AND calendar_id = ?",
      accountId,
      calendarId,
    ),
    db.getAllAsync<{ json: string }>(
      "SELECT json FROM series WHERE account_id = ? AND calendar_id = ?",
      accountId,
      calendarId,
    ),
    db.getAllAsync<{ json: string }>(
      `SELECT json FROM overrides WHERE series_id IN
         (SELECT id FROM series WHERE account_id = ? AND calendar_id = ?)`,
      accountId,
      calendarId,
    ),
  ]);
  return {
    singles: parseRows(singles),
    allDays: parseRows(allDays),
    series: parseRows(series),
    overrides: parseRows(overrides),
  };
}

// ---- 書き込み ----
async function deleteCalendar(db: SQLite.SQLiteDatabase, accountId: string, calendarId: string) {
  await db.runAsync(
    `DELETE FROM overrides WHERE series_id IN
       (SELECT id FROM series WHERE account_id = ? AND calendar_id = ?)`,
    accountId,
    calendarId,
  );
  for (const table of ["series", "singles", "all_days"]) {
    await db.runAsync(`DELETE FROM ${table} WHERE account_id = ? AND calendar_id = ?`, accountId, calendarId);
  }
}

/**
 * 1 カレンダーぶんの同期結果を適用する。全体を 1 つのトランザクションにして、途中で失敗しても
 * 「消しただけで入れ直していない」状態を残さない(Web の applyFullSyncAtomic と同じ理由)。
 */
export async function applySync(
  accountId: string,
  calendarId: string,
  mapped: MappedSync,
  isFullSync: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    // 中止された読み込み(ログアウト等)は、トランザクションの中でも書かない。
    // 呼び出し側の確認から、ここへ来るまでの間に中止されることがあるため。
    if (signal?.aborted) return;
    if (isFullSync) {
      await deleteCalendar(db, accountId, calendarId);
    } else if (mapped.deletedSeriesIds.length > 0) {
      // 削除通知は種別が分からないので、実際に series として存在するものだけを、
      // その例外インスタンスごと消す(Web の deleteRemovedSeries と同じ)
      for (const id of mapped.deletedSeriesIds) {
        await db.runAsync("DELETE FROM overrides WHERE series_id = ?", id);
        await db.runAsync("DELETE FROM series WHERE id = ?", id);
      }
    }
    for (const s of mapped.series) {
      await db.runAsync(
        "INSERT OR REPLACE INTO series (id, account_id, calendar_id, json) VALUES (?, ?, ?, ?)",
        s.id,
        accountId,
        calendarId,
        JSON.stringify(s),
      );
    }
    for (const o of mapped.overrides) {
      await db.runAsync(
        "INSERT OR REPLACE INTO overrides (id, series_id, json) VALUES (?, ?, ?)",
        o.id,
        o.seriesId,
        JSON.stringify(o),
      );
    }
    for (const o of mapped.singles) {
      await db.runAsync(
        "INSERT OR REPLACE INTO singles (id, account_id, calendar_id, json) VALUES (?, ?, ?, ?)",
        o.id,
        accountId,
        calendarId,
        JSON.stringify(o),
      );
    }
    for (const id of mapped.deletedSingleIds) await db.runAsync("DELETE FROM singles WHERE id = ?", id);
    for (const o of mapped.allDays) {
      await db.runAsync(
        "INSERT OR REPLACE INTO all_days (id, account_id, calendar_id, json) VALUES (?, ?, ?, ?)",
        o.id,
        accountId,
        calendarId,
        JSON.stringify(o),
      );
    }
    for (const id of mapped.deletedAllDayIds) await db.runAsync("DELETE FROM all_days WHERE id = ?", id);
  });
}

/** 表示対象から外れたカレンダーのデータを消す(残すキー以外を削除)。 */
export async function dropCalendarsExcept(keep: Set<string>): Promise<void> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ account_id: string; calendar_id: string }>(
    `SELECT DISTINCT account_id, calendar_id FROM singles
     UNION SELECT DISTINCT account_id, calendar_id FROM all_days
     UNION SELECT DISTINCT account_id, calendar_id FROM series`,
  );
  await db.withTransactionAsync(async () => {
    for (const r of rows) {
      if (!keep.has(calKey(r.account_id, r.calendar_id))) {
        await deleteCalendar(db, r.account_id, r.calendar_id);
      }
    }
  });
}

/** ログアウト時: 保存した予定とメタ情報をすべて消す(端末に他人の予定を残さない)。 */
export async function clearAll(): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const table of ["singles", "all_days", "series", "overrides", "meta"]) {
      await db.runAsync(`DELETE FROM ${table}`);
    }
  });
}

// ---- 楽観的更新用の単体の書き込み ----
// (予定の削除・作成・編集で、同期を待たずに手元のデータを書き換える。サーバーへの書き戻しが
//  失敗したら、同じ関数で元に戻す)
export async function upsertSingle(o: Occurrence): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO singles (id, account_id, calendar_id, json) VALUES (?, ?, ?, ?)",
    o.id,
    o.accountId ?? "",
    o.calendarId ?? "",
    JSON.stringify(o),
  );
}

export async function removeSingle(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM singles WHERE id = ?", id);
}

export async function upsertAllDay(o: AllDayOccurrence): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO all_days (id, account_id, calendar_id, json) VALUES (?, ?, ?, ?)",
    o.id,
    o.accountId ?? "",
    o.calendarId ?? "",
    JSON.stringify(o),
  );
}

export async function removeAllDay(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM all_days WHERE id = ?", id);
}

export async function upsertOverride(o: InstanceOverride): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR REPLACE INTO overrides (id, series_id, json) VALUES (?, ?, ?)",
    o.id,
    o.seriesId,
    JSON.stringify(o),
  );
}

export async function removeOverride(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM overrides WHERE id = ?", id);
}
