import { describe, expect, it, vi } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";
import { MIRROR_MARKER_KEY, MIRROR_RULE_KEY, MIRROR_SOURCE_KEY } from "../src/core/block-reconcile";

/**
 * `/api/block-mirrors/orphans` (GET) と `/api/block-mirrors/cleanup` (POST) のルート結線
 * (2026-08-04)。
 *
 * 判定そのもの (classifyMirrorState / extractOrphanMirrors / isWritableCalendar) は
 * core/block-orphans.ts 側の純関数・単体テストで固めてあるので (test/block-orphans.test.ts)、
 * ここで確かめるのは「ルートがその判断を D1 と DO RPC に正しく配線しているか」だけ:
 * - 書き込み可能なカレンダーだけを走査し、1カレンダー/1アカウントの失敗が他を止めない
 * - 削除前に必ず getEvent で再検証してから deleteEvent を呼ぶ (孤児でなければ呼ばない)
 * - items の空/上限超え/他人のアカウント参照を弾く
 *
 * D1/DO は最小限のフェイクを注入する。本番 D1 には一切触れない。
 */

const PROFILE_ID = "profile-1";
const SESSION_SECRET = "test-session-secret";

interface Recorded {
  sql: string;
  params: unknown[];
}

function makeFakeDb(rows: (sql: string, params: unknown[]) => unknown) {
  const executed: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const recorded: Recorded = { sql, params };
          executed.push(recorded);
          return {
            ...recorded,
            first: async () => rows(sql, params) ?? null,
            all: async () => ({ results: (rows(sql, params) as unknown[]) ?? [] }),
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
  return { db, executed };
}

function makeEnv(db: unknown, userSync: unknown): Env {
  return { SESSION_SECRET, DB: db, USER_SYNC: userSync } as unknown as Env;
}

async function authedGet(env: Env) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/block-mirrors/orphans",
    { method: "GET", headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
    env,
  );
}

async function authedCleanup(env: Env, body: unknown) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/block-mirrors/cleanup",
    {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function mirrorEvent(id: string, ruleId: string | null, sourceEventId: string | null = "src-1") {
  const props: Record<string, string> = { [MIRROR_MARKER_KEY]: "1" };
  if (ruleId) props[MIRROR_RULE_KEY] = ruleId;
  if (sourceEventId) props[MIRROR_SOURCE_KEY] = sourceEventId;
  return {
    id,
    status: "confirmed" as const,
    start: { dateTime: "2026-07-20T10:00:00+09:00" },
    end: { dateTime: "2026-07-20T11:00:00+09:00" },
    extendedProperties: { private: props },
  };
}

/** 空のプロファイル (アカウント無し、ルール無し) を返す D1 フェイク。 */
function emptyProfileRows(sql: string): unknown {
  if (sql.includes("FROM accounts WHERE profile_id = ?")) return [];
  if (sql.includes("FROM block_rules WHERE profile_id = ?")) return [];
  return null;
}

describe("GET /api/block-mirrors/orphans", () => {
  it("アカウント・ルールが無ければ空の結果を返す", async () => {
    const { db } = makeFakeDb(emptyProfileRows);
    const userSync = { getByName: () => ({ listCalendars: vi.fn() }) };
    const res = await authedGet(makeEnv(db, userSync));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: [], orphans: [] });
  });

  it("書き込み可能なカレンダーだけを走査し、孤児だけを orphans に積む", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE profile_id = ?")) return [{ id: "acc-1" }];
      if (sql.includes("FROM block_rules WHERE profile_id = ?")) return [];
      return null;
    });

    const listCalendars = vi.fn(async () => ({
      ok: true,
      data: [
        { id: "cal-writer", summary: "Writer Cal", accessRole: "writer" },
        { id: "cal-reader", summary: "Reader Cal", accessRole: "reader" },
      ],
    }));
    const scanMirrorEvents = vi.fn(async () => ({
      ok: true,
      data: [mirrorEvent("mirror-orphan", "rule-gone")],
    }));
    const userSync = { getByName: () => ({ listCalendars, scanMirrorEvents }) };

    const res = await authedGet(makeEnv(db, userSync));

    expect(res.status).toBe(200);
    // reader カレンダーは走査しない (scanMirrorEvents は writer の1カレンダーぶんだけ呼ばれる)
    expect(scanMirrorEvents).toHaveBeenCalledTimes(1);
    expect(scanMirrorEvents).toHaveBeenCalledWith("acc-1", "cal-writer");

    const body = (await res.json()) as {
      scanned: unknown[];
      orphans: { eventId: string; ruleId: string | null }[];
    };
    expect(body.scanned).toEqual([
      { accountId: "acc-1", calendarId: "cal-writer", calendarSummary: "Writer Cal", ok: true },
    ]);
    expect(body.orphans).toEqual([
      {
        accountId: "acc-1",
        calendarId: "cal-writer",
        eventId: "mirror-orphan",
        start: { dateTime: "2026-07-20T10:00:00+09:00" },
        end: { dateTime: "2026-07-20T11:00:00+09:00" },
        ruleId: "rule-gone",
        sourceEventId: "src-1",
      },
    ]);
  });

  it("生きているミラー (target と id が一致するルールがある) は orphans に含めない", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE profile_id = ?")) return [{ id: "acc-1" }];
      if (sql.includes("FROM block_rules WHERE profile_id = ?")) {
        return [{ id: "rule-1", target_account_id: "acc-1", target_calendar_id: "cal-1" }];
      }
      return null;
    });
    const listCalendars = vi.fn(async () => ({
      ok: true,
      data: [{ id: "cal-1", summary: "Cal", accessRole: "owner" }],
    }));
    const scanMirrorEvents = vi.fn(async () => ({
      ok: true,
      data: [mirrorEvent("mirror-alive", "rule-1")],
    }));
    const userSync = { getByName: () => ({ listCalendars, scanMirrorEvents }) };

    const res = await authedGet(makeEnv(db, userSync));
    const body = (await res.json()) as { orphans: unknown[] };
    expect(body.orphans).toEqual([]);
  });

  it("1カレンダーの走査失敗は scanned に ok:false で残し、他のカレンダーは続行する", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE profile_id = ?")) return [{ id: "acc-1" }];
      if (sql.includes("FROM block_rules WHERE profile_id = ?")) return [];
      return null;
    });
    const listCalendars = vi.fn(async () => ({
      ok: true,
      data: [
        { id: "cal-bad", summary: "Bad Cal", accessRole: "owner" },
        { id: "cal-ok", summary: "Ok Cal", accessRole: "owner" },
      ],
    }));
    const scanMirrorEvents = vi.fn(async (_accountId: string, calendarId: string) => {
      if (calendarId === "cal-bad") return { ok: false, status: 403, error: "forbidden" };
      return { ok: true, data: [mirrorEvent("mirror-orphan", null)] };
    });
    const userSync = { getByName: () => ({ listCalendars, scanMirrorEvents }) };

    const res = await authedGet(makeEnv(db, userSync));
    const body = (await res.json()) as { scanned: { ok: boolean }[]; orphans: unknown[] };

    expect(body.scanned).toEqual([
      { accountId: "acc-1", calendarId: "cal-bad", calendarSummary: "Bad Cal", ok: false, error: "forbidden" },
      { accountId: "acc-1", calendarId: "cal-ok", calendarSummary: "Ok Cal", ok: true },
    ]);
    expect(body.orphans).toHaveLength(1);
  });

  it("アカウント単位でカレンダー一覧が取れない場合も他のアカウントを続行する", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE profile_id = ?")) {
        return [{ id: "acc-bad" }, { id: "acc-ok" }];
      }
      if (sql.includes("FROM block_rules WHERE profile_id = ?")) return [];
      return null;
    });
    const listCalendars = vi.fn(async (accountId: string) => {
      if (accountId === "acc-bad") return { ok: false, status: 401, error: "not_connected" };
      return { ok: true, data: [] };
    });
    const userSync = { getByName: () => ({ listCalendars, scanMirrorEvents: vi.fn() }) };

    const res = await authedGet(makeEnv(db, userSync));
    const body = (await res.json()) as { scanned: unknown[] };
    expect(body.scanned).toEqual([
      { accountId: "acc-bad", calendarId: "", calendarSummary: "", ok: false, error: "not_connected" },
    ]);
  });
});

describe("POST /api/block-mirrors/cleanup", () => {
  it("items が空なら 400 empty_items", async () => {
    const { db } = makeFakeDb(emptyProfileRows);
    const res = await authedCleanup(makeEnv(db, { getByName: () => ({}) }), { items: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_items" });
  });

  it("items が MAX_CLEANUP_ITEMS を超えたら 400 too_many_items", async () => {
    const { db } = makeFakeDb(emptyProfileRows);
    const items = Array.from({ length: 501 }, (_, i) => ({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: `ev-${i}`,
    }));
    const res = await authedCleanup(makeEnv(db, { getByName: () => ({}) }), { items });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too_many_items" });
  });

  it("items の形が不正なら 400 missing_fields", async () => {
    const { db } = makeFakeDb(emptyProfileRows);
    const res = await authedCleanup(makeEnv(db, { getByName: () => ({}) }), {
      items: [{ accountId: "acc-1" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_fields" });
  });

  it("他人のプロファイルのアカウントを参照していたら 403 で、Google には一切触れない", async () => {
    const { db } = makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE id = ?")) return null; // 所属なし
      return null;
    });
    const getEvent = vi.fn();
    const deleteEvent = vi.fn();
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "other-acc", calendarId: "cal-1", eventId: "ev-1" }],
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_not_found" });
    expect(getEvent).not.toHaveBeenCalled();
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  function makeOwnedDb(ruleRows: unknown[] = []) {
    return makeFakeDb((sql) => {
      if (sql.includes("FROM accounts WHERE id = ?")) return { profile_id: PROFILE_ID };
      if (sql.includes("FROM block_rules WHERE profile_id = ?")) return ruleRows;
      return null;
    }).db;
  }

  it("events.get が 404 なら削除を試みず failed:not_found", async () => {
    const db = makeOwnedDb();
    const getEvent = vi.fn(async () => ({ ok: true, data: null }));
    const deleteEvent = vi.fn();
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "acc-1", calendarId: "cal-1", eventId: "ev-gone" }],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0, failed: [{ eventId: "ev-gone", reason: "not_found" }] });
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("再検証で生きていると分かったら削除せず failed:not_orphan:alive", async () => {
    const db = makeOwnedDb([
      { id: "rule-1", target_account_id: "acc-1", target_calendar_id: "cal-1" },
    ]);
    const getEvent = vi.fn(async () => ({ ok: true, data: mirrorEvent("ev-1", "rule-1") }));
    const deleteEvent = vi.fn();
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "acc-1", calendarId: "cal-1", eventId: "ev-1" }],
    });

    expect(await res.json()).toEqual({
      deleted: 0,
      failed: [{ eventId: "ev-1", reason: "not_orphan:alive" }],
    });
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("mirror の目印が無くなっていたら削除せず failed:not_orphan:not_a_mirror", async () => {
    const db = makeOwnedDb();
    const getEvent = vi.fn(async () => ({
      ok: true,
      data: { id: "ev-1", status: "confirmed" as const },
    }));
    const deleteEvent = vi.fn();
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "acc-1", calendarId: "cal-1", eventId: "ev-1" }],
    });

    expect(await res.json()).toEqual({
      deleted: 0,
      failed: [{ eventId: "ev-1", reason: "not_orphan:not_a_mirror" }],
    });
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("再検証で孤児と確認できたら deleteEvent を呼び、成功したら deleted に数える", async () => {
    const db = makeOwnedDb();
    const getEvent = vi.fn(async () => ({ ok: true, data: mirrorEvent("ev-1", "rule-gone") }));
    const deleteEvent = vi.fn(async () => ({ ok: true, data: undefined }));
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "acc-1", calendarId: "cal-1", eventId: "ev-1" }],
    });

    expect(await res.json()).toEqual({ deleted: 1, failed: [] });
    expect(deleteEvent).toHaveBeenCalledWith("acc-1", "cal-1", "ev-1");
  });

  it("Google の削除自体が失敗したら failed:delete_failed で1件失敗を報告する (他は続行)", async () => {
    const db = makeOwnedDb();
    const getEvent = vi.fn(async () => ({ ok: true, data: mirrorEvent("ev-1", "rule-gone") }));
    const deleteEvent = vi.fn(async () => ({ ok: false, status: 403, error: "forbidden" }));
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [{ accountId: "acc-1", calendarId: "cal-1", eventId: "ev-1" }],
    });

    expect(await res.json()).toEqual({
      deleted: 0,
      failed: [{ eventId: "ev-1", reason: "delete_failed:forbidden" }],
    });
  });

  it("複数件のうち1件が失敗しても残りは続行する (best-effort)", async () => {
    const db = makeOwnedDb();
    const getEvent = vi.fn(async (_accountId: string, _calendarId: string, eventId: string) => {
      if (eventId === "ev-bad") return { ok: false, status: 500, error: "internal_error" };
      return { ok: true, data: mirrorEvent(eventId, "rule-gone") };
    });
    const deleteEvent = vi.fn(async () => ({ ok: true, data: undefined }));
    const userSync = { getByName: () => ({ getEvent, deleteEvent }) };

    const res = await authedCleanup(makeEnv(db, userSync), {
      items: [
        { accountId: "acc-1", calendarId: "cal-1", eventId: "ev-bad" },
        { accountId: "acc-1", calendarId: "cal-1", eventId: "ev-good" },
      ],
    });

    expect(await res.json()).toEqual({
      deleted: 1,
      failed: [{ eventId: "ev-bad", reason: "fetch_failed:internal_error" }],
    });
  });
});
