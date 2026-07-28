import { describe, expect, it, vi } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";

/**
 * `/api/block-rules` の**ミラー予定の後始末**まわりのルート結線 (2026-07-28)。
 *
 * 判断そのもの (resolveDeleteMirrors / shouldDiscardMirrorRows / deleteRuleMirrors) は
 * core 側の純関数・注入テストで固めてあるので、ここで確かめるのは「ルートがその判断を
 * 正しく D1 と DO RPC に配線しているか」だけ:
 *
 * - DELETE で deleteMirrors:true のときだけ Google の削除 RPC を呼ぶ (省略時は呼ばない)
 * - Google の削除が失敗してもルール行は必ず消す (204 を返す)
 * - POST で target が変わったときだけ block_mirrors の行を捨てる (**404 バグの本体**)
 *
 * D1/DO は最小限のフェイクを注入する (このリポジトリの他のテストと同じく実バインディングは
 * 使わない)。本番 D1 には一切触れない。
 */

const PROFILE_ID = "profile-1";
const SESSION_SECRET = "test-session-secret";

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * D1Database の最小フェイク。prepare().bind() された文を全部記録し、first()/all() の
 * 戻り値は SQL の断片で引く rows ハンドラに委ねる。batch() は渡された文の配列を記録する。
 */
function makeFakeDb(rows: (sql: string, params: unknown[]) => unknown) {
  const executed: Recorded[] = [];
  const batches: Recorded[][] = [];
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
    async batch(statements: Recorded[]) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
  return { db, executed, batches };
}

/** UserSyncDO の最小フェイク。deleteEvent の呼び出しだけを見る。 */
function makeFakeUserSync(deleteEvent: ReturnType<typeof vi.fn>) {
  return { getByName: () => ({ deleteEvent }) };
}

function makeEnv(db: unknown, userSync: unknown): Env {
  return { SESSION_SECRET, DB: db, USER_SYNC: userSync } as unknown as Env;
}

async function authedRequest(env: Env, method: string, body: unknown) {
  const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);
  return apiRoutes.request(
    "/api/block-rules",
    {
      method,
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** 既存ルール1件 (target=tgt-acc/tgt-cal) と mirror 2件がある状態の D1 応答。 */
function existingRuleRows(sql: string): unknown {
  if (sql.includes("FROM block_rules WHERE id = ?")) {
    return {
      profile_id: PROFILE_ID,
      ooo_fallback: 0,
      target_account_id: "tgt-acc",
      target_calendar_id: "tgt-cal",
    };
  }
  if (sql.includes("FROM block_mirrors WHERE rule_id = ?")) {
    return [
      {
        rule_id: "rule-1",
        source_event_id: "ev-1",
        mirror_event_id: "mirror-1",
        source_updated: null,
        created_at: 1000,
      },
      {
        rule_id: "rule-1",
        source_event_id: "ev-2",
        mirror_event_id: "mirror-2",
        source_updated: null,
        created_at: 1000,
      },
    ];
  }
  return null;
}

/** 既存ルール1件 + mirror 2件。参照アカウントは全てこのプロファイルのもの、として応答する。 */
function existingRuleDbRows(sql: string, params: unknown[]): unknown {
  // accountsAllBelongToProfile: 問い合わせられた id (params[0] は profileId) をそのまま返す
  if (sql.includes("FROM accounts WHERE profile_id = ?")) {
    return params.slice(1).map((id) => ({ id }));
  }
  return existingRuleRows(sql);
}

describe("DELETE /api/block-rules のミラー削除", () => {
  it("deleteMirrors:true なら Google のミラー予定を全件消してからルール行を消す", async () => {
    const deleteEvent = vi.fn(async () => ({ ok: true, data: undefined }));
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "DELETE", {
      id: "rule-1",
      deleteMirrors: true,
    });

    expect(res.status).toBe(204);
    expect(deleteEvent).toHaveBeenCalledTimes(2);
    expect(deleteEvent).toHaveBeenNthCalledWith(1, "tgt-acc", "tgt-cal", "mirror-1");
    expect(deleteEvent).toHaveBeenNthCalledWith(2, "tgt-acc", "tgt-cal", "mirror-2");
    // ルール行 / source 行 / 対応表の3つは常に消える
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((s) => s.sql)).toEqual([
      "DELETE FROM block_rules WHERE id = ?",
      "DELETE FROM block_rule_sources WHERE rule_id = ?",
      "DELETE FROM block_mirrors WHERE rule_id = ?",
    ]);
  });

  it("フラグ省略時は Google の予定を消さない (旧クライアント/MCP からの削除で巻き添えにしない)", async () => {
    const deleteEvent = vi.fn(async () => ({ ok: true, data: undefined }));
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "DELETE", {
      id: "rule-1",
    });

    expect(res.status).toBe(204);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
  });

  it("deleteMirrors:false でも同じく消さない", async () => {
    const deleteEvent = vi.fn(async () => ({ ok: true, data: undefined }));
    const { db } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "DELETE", {
      id: "rule-1",
      deleteMirrors: false,
    });

    expect(res.status).toBe(204);
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("Google の削除が失敗してもルール行は消し、204 を返す (削除できない状態に閉じ込めない)", async () => {
    const deleteEvent = vi.fn(async () => ({ ok: false, status: 403, error: "forbidden" }));
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "DELETE", {
      id: "rule-1",
      deleteMirrors: true,
    });

    expect(res.status).toBe(204);
    expect(deleteEvent).toHaveBeenCalledTimes(2); // 1件目の失敗で止まらない
    expect(batches).toHaveLength(1);
  });

  it("deleteMirrors が boolean でなければ 400 (曖昧な指定で予定を消させない)", async () => {
    const deleteEvent = vi.fn();
    const { db } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "DELETE", {
      id: "rule-1",
      deleteMirrors: "yes",
    });

    expect(res.status).toBe(400);
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});

/**
 * target を変えたのに block_mirrors の行が残ると、**古い target に作った event id を
 * 新しい target に対して patch/delete しにいって必ず 404 になる** (孤児も残る)。
 * その回帰を「更新の batch に block_mirrors の DELETE が含まれるか」で固定する
 * (404 が起きるリコンサイル側の振る舞いは block-orchestrate.test.ts の
 * 「target 変更後のリコンサイル (404 回帰)」を参照)。
 */
describe("POST /api/block-rules で target を変えたときの対応表の整理", () => {
  const BASE_BODY = {
    id: "rule-1",
    sources: [{ accountId: "src-acc", calendarId: "src-cal" }],
    mode: "busy" as const,
  };

  it("target が変わったら block_mirrors の行を捨てる (404 バグの修正)", async () => {
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await apiRoutes.request(
      "/api/block-rules",
      {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${await createSessionCookieValue(SESSION_SECRET, PROFILE_ID)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...BASE_BODY,
          target: { accountId: "tgt-acc-2", calendarId: "tgt-cal-2" },
        }),
      },
      makeEnv(db, makeFakeUserSync(vi.fn())),
    );

    expect(res.status).toBe(200);
    const sqls = batches[0]!.map((s) => s.sql);
    expect(sqls).toContain("DELETE FROM block_mirrors WHERE rule_id = ?");
  });

  it("target が同じなら行を残す (既存のミラーを使い続ける)", async () => {
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(vi.fn())), "POST", {
      ...BASE_BODY,
      target: { accountId: "tgt-acc", calendarId: "tgt-cal" },
    });

    expect(res.status).toBe(200);
    const sqls = batches[0]!.map((s) => s.sql);
    expect(sqls).not.toContain("DELETE FROM block_mirrors WHERE rule_id = ?");
  });

  it("新規作成 (id 無し) では捨てる行がそもそも無い", async () => {
    const { db, batches } = makeFakeDb(existingRuleDbRows);
    const res = await authedRequest(makeEnv(db, makeFakeUserSync(vi.fn())), "POST", {
      sources: BASE_BODY.sources,
      target: { accountId: "tgt-acc", calendarId: "tgt-cal" },
      mode: "busy",
    });

    expect(res.status).toBe(200);
    const sqls = batches[0]!.map((s) => s.sql);
    expect(sqls).not.toContain("DELETE FROM block_mirrors WHERE rule_id = ?");
  });

  it("target が変わっても Google の予定は消さない (古い target のミラーは残す)", async () => {
    const deleteEvent = vi.fn();
    const { db } = makeFakeDb(existingRuleDbRows);
    await authedRequest(makeEnv(db, makeFakeUserSync(deleteEvent)), "POST", {
      ...BASE_BODY,
      target: { accountId: "tgt-acc-2", calendarId: "tgt-cal-2" },
    });

    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
