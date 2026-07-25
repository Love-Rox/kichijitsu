import { describe, expect, it } from "vite-plus/test";
import { apiRoutes } from "../src/routes/api";
import { createSessionCookieValue, SESSION_COOKIE_NAME } from "../src/session";

/**
 * `/api/*` の**認証の適用漏れ検出**(リファクタリング フェーズ4、2026-07-25)。
 *
 * routes/api.ts はドメイン別のルーターに分割してある (github/work-logs/events/calendars-tasks/
 * settings)。分割やルート追加の際に `requireAuth` を付け忘れると、セッション cookie 無しで他人の
 * データに触れる経路ができてしまう — grep では「付いているつもり」を検出できないので、
 * **Hono に登録された全ルートを列挙して**実際にリクエストを投げ、未認証が 401 になることを機械的に
 * 確認する。ここに載っているのは登録済みルートの全件なので、新しいルートを足したときも自動で対象に
 * なる (認証を付け忘れれば落ちる)。
 *
 * 唯一の例外が GET /api/me — 未認証でも 200 で `connected: false` を返すのが仕様
 * (クライアントは起動時にこれを叩いて「連携済みか」を判定する)。
 *
 * env は空オブジェクトで足りる: requireAuth は D1/DO に触れる前に 401 を返すため、この経路では
 * バインディングが一切使われない (逆に言えば、401 が返らなければ本物のバインディングを要求する
 * エラーになるので、その場合もこのテストは失敗する)。
 */
const ENV = {} as unknown as Env;

/** 認証不要が仕様のルート (`METHOD path` 形式)。 */
const PUBLIC_ROUTES = new Set(["GET /api/me"]);

/** `/api/work-logs/:id` のようなパラメータを実際に投げられる値に置き換える。 */
function samplePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, "sample-id");
}

describe("apiRoutes の認証適用", () => {
  // method "ALL" は use() で登録したミドルウェア (populateProfileId) の登録行なので除く。
  const routes = apiRoutes.routes.filter((route) => route.method !== "ALL");

  it("ルートが1つも取れていない、という取り違えを防ぐ", () => {
    expect(routes.length).toBeGreaterThanOrEqual(35);
  });

  // populateProfileId は routes/api.ts で1回だけ登録する (サブルーターごとに use("*") すると
  // 1リクエストにつき cookie の HMAC 検証が何度も走る)。ミドルウェア登録は method "ALL" の
  // ルートとして現れるので、その数で「1回だけ」を固定する。
  it("ミドルウェアの適用は1箇所だけ (cookie 検証が多重に走らない)", () => {
    const middlewares = apiRoutes.routes.filter((route) => route.method === "ALL");
    expect(middlewares).toHaveLength(1);
    expect(middlewares[0]?.path).toBe("/*");
  });

  it("GET /api/me 以外の全ルートは、セッション cookie 無しなら 401 unauthorized", async () => {
    const offenders: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC_ROUTES.has(key)) continue;
      const res = await apiRoutes.request(samplePath(route.path), { method: route.method }, ENV);
      if (res.status !== 401) offenders.push(`${key} -> ${res.status}`);
    }
    expect(offenders).toEqual([]);
  });

  it("GET /api/me は未認証でも 200 で connected:false を返す", async () => {
    const res = await apiRoutes.request("/api/me", { method: "GET" }, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connected: false, accounts: [] });
  });

  /**
   * 上の「未認証は全部 401」だけでは、populateProfileId がサブルーターのルートに**適用されて
   * いない**という壊れ方 (= 正しい cookie でも常に 401) を検出できないので、逆向きも固定する。
   *
   * populateProfileId は routes/api.ts の `use("*", ...)` 1箇所だけで適用され、サブルーターは
   * `route("/")` でマウントされている。Hono のマージ順 (先に登録したミドルウェアが先に走る) に
   * 依存しているため、ここが崩れると全 API が無条件 401 になる — その回帰を防ぐ。
   *
   * 対象は GET /api/calendars: 認証を通った後、D1/DO に触れる前に accountId 未指定で
   * 400 missing_accountId を返すので、バインディング無しの env でも「認証を通り抜けた」ことだけを
   * 確かめられる。
   */
  it("正しいセッション cookie なら requireAuth を通る (populateProfileId がサブルーターにも効いている)", async () => {
    const secret = "test-session-secret";
    const sid = await createSessionCookieValue(secret, "profile-123");
    const res = await apiRoutes.request(
      "/api/calendars",
      { method: "GET", headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
      { SESSION_SECRET: secret } as unknown as Env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_accountId" });
  });
});
