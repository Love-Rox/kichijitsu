import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { authRoutes } from "../src/routes/auth";
import {
  desktopAuthRoutes,
  issueDesktopTicket,
  renderDesktopHandoffPage,
} from "../src/routes/desktop-auth";
import {
  DESKTOP_ADD_TOKEN_TTL_MS,
  DESKTOP_DEEP_LINK_SCHEME,
  DESKTOP_TICKET_TTL_MS,
  buildDesktopDeepLink,
  createDesktopAddToken,
  generateDesktopTicket,
  hashDesktopSecret,
  isDesktopTicketFresh,
  isValidDesktopHex32,
  isValidDesktopTicketFormat,
  parseDesktopLoginChallenge,
  timingSafeEqualString,
  verifyDesktopAddToken,
} from "../src/core/desktop-auth";
import {
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
  createSessionCookieValue,
  verifySessionCookieValue,
} from "../src/session";
import { decodeOAuthState } from "../src/oauth-state";

/**
 * デスクトップ版 (Tauri) の外部ブラウザ OAuth (2026-08-07)。
 * 設計と「なぜ」は src/core/desktop-auth.ts / src/routes/desktop-auth.ts の冒頭コメント参照。
 *
 * ここで守りたい性質は4つ:
 *   1. チケットは推測不能・短命・**単回使用**である
 *   2. 交換時にプロファイルの取り違えが起きない (PKCE 相当の challenge/verifier 結び付け)
 *   3. add モードが外部ブラウザ (= sid cookie が無い) でも正しいプロファイルへ足される
 *   4. **ブラウザ版/PWA の挙動が1ミリも変わらない**
 */

const SESSION_SECRET = "test-session-secret";
const TOKEN_ENC_KEY = "ZmFrZS1rZXktZm9yLXRlc3RpbmctMzItYnl0ZXMhISE="; // 32 bytes, base64
const APP_URL = "https://app.example.test/app";

// --- 1. 純関数 (生成・形式判定・寿命判定) ---

describe("チケット/verifier の生成と形式判定", () => {
  it("生成したチケットは base64url 43 文字 (=32 バイト) で、毎回異なる", () => {
    const a = generateDesktopTicket();
    const b = generateDesktopTicket();
    expect(a).toHaveLength(43);
    expect(isValidDesktopTicketFormat(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("形式判定は長さちょうど・base64url 文字のみを要求する", () => {
    expect(isValidDesktopTicketFormat("a".repeat(43))).toBe(true);
    expect(isValidDesktopTicketFormat("a".repeat(42))).toBe(false);
    expect(isValidDesktopTicketFormat("a".repeat(44))).toBe(false);
    // base64url に含まれない文字 (`+` `/` `=` や記号) は拒否。
    expect(isValidDesktopTicketFormat(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidDesktopTicketFormat(`${"a".repeat(42)}=`)).toBe(false);
    expect(isValidDesktopTicketFormat("")).toBe(false);
  });

  it("verifier/challenge は小文字 hex 64 文字のみ (大文字・短い・長いは拒否)", () => {
    expect(isValidDesktopHex32("0".repeat(64))).toBe(true);
    expect(isValidDesktopHex32("abcdef0123456789".repeat(4))).toBe(true);
    expect(isValidDesktopHex32("A".repeat(64))).toBe(false);
    expect(isValidDesktopHex32("0".repeat(63))).toBe(false);
    expect(isValidDesktopHex32("0".repeat(65))).toBe(false);
    expect(isValidDesktopHex32("")).toBe(false);
  });

  it("SHA-256 は同じ入力で必ず同じ hex を返す (Rust 側と同じ既知ベクタで確認)", async () => {
    // Rust の sha2 で同じ値が出ることを保証する固定ベクタ (SHA-256("abc"))。
    expect(await hashDesktopSecret("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await hashDesktopSecret("x")).toBe(await hashDesktopSecret("x"));
    expect(await hashDesktopSecret("x")).not.toBe(await hashDesktopSecret("y"));
    expect(isValidDesktopHex32(await hashDesktopSecret("abc"))).toBe(true);
  });

  it("寿命判定は境界 (now === expiresAt) を期限切れ扱いにする", () => {
    expect(isDesktopTicketFresh(1000, 999)).toBe(true);
    expect(isDesktopTicketFresh(1000, 1000)).toBe(false);
    expect(isDesktopTicketFresh(1000, 1001)).toBe(false);
  });

  it("定数時間比較は長さ違い・1文字違いを弾き、一致だけ true", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });

  it("ディープリンクは tauri.conf.json のスキームと同じ kichijitsu:// を使う", () => {
    expect(DESKTOP_DEEP_LINK_SCHEME).toBe("kichijitsu");
    expect(buildDesktopDeepLink("abc-_123")).toBe("kichijitsu://auth?ticket=abc-_123");
  });

  it("チケットの寿命は数分オーダー (長すぎる設定を事故で入れない歯止め)", () => {
    expect(DESKTOP_TICKET_TTL_MS).toBeGreaterThanOrEqual(60 * 1000);
    expect(DESKTOP_TICKET_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});

describe("parseDesktopLoginChallenge (ブラウザ経路との分岐点)", () => {
  const challenge = "a".repeat(64);

  it("desktop=1 と正しい形式の dc が両方そろったときだけ challenge を返す", () => {
    expect(parseDesktopLoginChallenge("1", challenge)).toBe(challenge);
  });

  it("ブラウザ版/PWA (どちらのクエリも無い) では必ず null", () => {
    expect(parseDesktopLoginChallenge(undefined, undefined)).toBeNull();
  });

  it("片方だけ・値が不正なら null (中途半端な入力でデスクトップ経路に入らない)", () => {
    expect(parseDesktopLoginChallenge("1", undefined)).toBeNull();
    expect(parseDesktopLoginChallenge(undefined, challenge)).toBeNull();
    expect(parseDesktopLoginChallenge("0", challenge)).toBeNull();
    expect(parseDesktopLoginChallenge("true", challenge)).toBeNull();
    expect(parseDesktopLoginChallenge("1", "short")).toBeNull();
    expect(parseDesktopLoginChallenge("1", "Z".repeat(64))).toBeNull();
  });
});

// --- 2. add モード用の署名付きトークン ---

describe("add モードの署名付きトークン", () => {
  it("往復して profileId が戻る", async () => {
    const token = await createDesktopAddToken(SESSION_SECRET, "profile-A", 1_000_000);
    expect(await verifyDesktopAddToken(SESSION_SECRET, token, 1_000_001)).toBe("profile-A");
  });

  it("profileId にドットが含まれていても壊れない", async () => {
    const token = await createDesktopAddToken(SESSION_SECRET, "a.b.c", 1_000_000);
    expect(await verifyDesktopAddToken(SESSION_SECRET, token, 1_000_001)).toBe("a.b.c");
  });

  it("期限切れ・改ざん・別の鍵・形式不正はすべて null", async () => {
    const issuedAt = 1_000_000;
    const token = await createDesktopAddToken(SESSION_SECRET, "profile-A", issuedAt);
    // 境界: 期限ちょうどは無効。
    expect(
      await verifyDesktopAddToken(SESSION_SECRET, token, issuedAt + DESKTOP_ADD_TOKEN_TTL_MS),
    ).toBeNull();
    // profileId のすげ替え (署名が合わなくなる)。
    const [, exp, sig] = token.split(".");
    expect(await verifyDesktopAddToken(SESSION_SECRET, `profile-B.${exp}.${sig}`, issuedAt)).toBe(
      null,
    );
    // 期限だけ延ばす改ざん。
    expect(
      await verifyDesktopAddToken(SESSION_SECRET, `profile-A.99999999999999.${sig}`, issuedAt),
    ).toBeNull();
    expect(await verifyDesktopAddToken("other-secret", token, issuedAt)).toBeNull();
    expect(await verifyDesktopAddToken(SESSION_SECRET, "not-a-token", issuedAt)).toBeNull();
    expect(await verifyDesktopAddToken(SESSION_SECRET, "", issuedAt)).toBeNull();
  });

  it(
    "sid とは交換できない (領域分離): add トークンは sid として通らず、" +
      "sid も add トークンとして通らない ―― 同じ SESSION_SECRET・同じ3パート形式なので、" +
      "署名対象に前置きを混ぜていないと 30 日有効なセッションが URL に載ってしまう",
    async () => {
      const now = 1_000_000;
      const addToken = await createDesktopAddToken(SESSION_SECRET, "profile-A", now);
      expect(await verifySessionCookieValue(SESSION_SECRET, addToken, now)).toBeNull();

      const sid = await createSessionCookieValue(SESSION_SECRET, "profile-A", now);
      expect(await verifyDesktopAddToken(SESSION_SECRET, sid, now)).toBeNull();
    },
  );
});

// --- 3. ルートを通した実際の流れ ---

/** id_token は署名検証せずデコードするだけ (google/oauth.ts decodeIdToken)。 */
function fakeIdToken(sub: string, email: string): string {
  const base64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${base64url({ alg: "none" })}.${base64url({ sub, email })}.sig`;
}

function stubTokenFetch(sub: string, email: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt-new",
        id_token: fakeIdToken(sub, email),
        scope: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/tasks",
        ].join(" "),
      }),
    ),
  );
}

/**
 * accounts + desktop_auth_tickets を持つ本物の SQLite を D1 の最小サブセットとして包む
 * (auth.test.ts の makeSqliteD1 と同じ流儀。こちらは batch と meta.changes も返す ――
 * 単回使用の担保が `DELETE ... の changes === 1` なので、そこを本物の SQL で確かめたい)。
 */
function makeSqliteD1(): { db: DatabaseSync; d1: unknown } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      email TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      reauth_required_at INTEGER
    );
    CREATE TABLE desktop_auth_tickets (
      ticket_hash TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const prepare = (sql: string) => ({
    bind(...params: unknown[]) {
      const sqliteParams = params as never[];
      return {
        first: async <T>() => (db.prepare(sql).get(...sqliteParams) as T | undefined) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all(...sqliteParams) as T[] }),
        run: async () => {
          const result = db.prepare(sql).run(...sqliteParams);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    },
  });
  const d1 = {
    prepare,
    async batch(statements: { run: () => Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return { db, d1 };
}

function makeEnv(d1: unknown): Env {
  return {
    SESSION_SECRET,
    TOKEN_ENC_KEY,
    APP_URL,
    ALLOWED_EMAILS: "",
    OAUTH_REDIRECT_URL: "",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    DB: d1,
  } as unknown as Env;
}

function extractCookieValue(setCookieHeader: string | null, name: string): string {
  if (!setCookieHeader) throw new Error("no Set-Cookie header");
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
  if (!match) throw new Error(`cookie ${name} not found in ${setCookieHeader}`);
  return match[1]!;
}

function ticketFromHandoffHtml(html: string): string {
  const match = /kichijitsu:\/\/auth\?ticket=([A-Za-z0-9_-]+)/.exec(html);
  if (!match) throw new Error(`no deep link in handoff page: ${html.slice(0, 200)}`);
  return match[1]!;
}

/** デスクトップ経路の /auth/login → /auth/callback を通し、受け取ったチケットを返す。 */
async function runDesktopOAuth(
  env: Env,
  challenge: string,
  { sub, email, query = "" }: { sub: string; email: string; query?: string },
): Promise<{ ticket: string; callbackRes: Response }> {
  const loginRes = await authRoutes.request(
    `/auth/login?desktop=1&dc=${challenge}${query}`,
    {},
    env,
  );
  const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

  stubTokenFetch(sub, email);
  let callbackRes: Response;
  try {
    callbackRes = await authRoutes.request(
      `/auth/callback?code=fake-code&state=${encodeURIComponent(stateValue)}`,
      { headers: { Cookie: `${STATE_COOKIE_NAME}=${stateValue}` } },
      env,
    );
  } finally {
    vi.unstubAllGlobals();
  }
  const html = await callbackRes.clone().text();
  return { ticket: ticketFromHandoffHtml(html), callbackRes };
}

describe("デスクトップ経路: /auth/login → /auth/callback → チケット交換", () => {
  const VERIFIER = "1".repeat(64);
  const SUB = "google-sub-desktop";
  const EMAIL = "desktop@example.com";

  it(
    "外部ブラウザ側の callback は sid を発行せず、kichijitsu:// への橋渡しページを返す " +
      "(Cookie を外部ブラウザに付けても webview には届かないため)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      const env = makeEnv(d1);
      const challenge = await hashDesktopSecret(VERIFIER);

      const { ticket, callbackRes } = await runDesktopOAuth(env, challenge, {
        sub: SUB,
        email: EMAIL,
      });

      expect(callbackRes.status).toBe(200);
      expect(callbackRes.headers.get("set-cookie")).not.toContain(`${SESSION_COOKIE_NAME}=`);
      expect(isValidDesktopTicketFormat(ticket)).toBe(true);
      // アカウントは通常どおり保存されている (login モードなのでオーナー)。
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(SUB) as {
        is_owner: number;
      };
      expect(account.is_owner).toBe(1);
      // D1 に生値は残らない (ハッシュのみ)。
      const row = db.prepare("SELECT * FROM desktop_auth_tickets").get() as {
        ticket_hash: string;
        challenge: string;
      };
      expect(row.ticket_hash).toBe(await hashDesktopSecret(ticket));
      expect(row.ticket_hash).not.toBe(ticket);
      expect(row.challenge).toBe(challenge);
    },
  );

  it("正しい verifier での交換は sid を発行して APP_URL へ戻す", async () => {
    const { d1 } = makeSqliteD1();
    const env = makeEnv(d1);
    const challenge = await hashDesktopSecret(VERIFIER);
    const { ticket } = await runDesktopOAuth(env, challenge, { sub: SUB, email: EMAIL });

    const res = await desktopAuthRoutes.request(
      `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
      {},
      env,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(APP_URL);
    const sid = extractCookieValue(res.headers.get("set-cookie"), SESSION_COOKIE_NAME);
    expect(await verifySessionCookieValue(SESSION_SECRET, sid)).toBeTruthy();
  });

  it("同じチケットでの2回目の交換は必ず失敗する (単回使用)", async () => {
    const { db, d1 } = makeSqliteD1();
    const env = makeEnv(d1);
    const challenge = await hashDesktopSecret(VERIFIER);
    const { ticket } = await runDesktopOAuth(env, challenge, { sub: SUB, email: EMAIL });

    const first = await desktopAuthRoutes.request(
      `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
      {},
      env,
    );
    expect(first.status).toBe(302);
    // 行は消えている = チケットの有効性そのものが消えている。
    expect(db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_tickets").get()).toMatchObject({
      n: 0,
    });

    const second = await desktopAuthRoutes.request(
      `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
      {},
      env,
    );
    expect(second.status).toBe(400);
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it(
    "verifier が一致しないチケットは 403 で、しかも**その1回で無効化される** " +
      "(悪意ある kichijitsu:// リンクを踏まされても他人のセッションを掴まない/総当たりもできない)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      const env = makeEnv(d1);
      const challenge = await hashDesktopSecret(VERIFIER);
      const { ticket } = await runDesktopOAuth(env, challenge, { sub: SUB, email: EMAIL });

      const wrong = await desktopAuthRoutes.request(
        `/auth/desktop/exchange?ticket=${ticket}&verifier=${"2".repeat(64)}`,
        {},
        env,
      );
      expect(wrong.status).toBe(403);
      expect(wrong.headers.get("set-cookie")).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_tickets").get()).toMatchObject({
        n: 0,
      });

      // 正しい verifier でも、もう蘇らない。
      const retry = await desktopAuthRoutes.request(
        `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
        {},
        env,
      );
      expect(retry.status).toBe(400);
    },
  );

  it("期限切れのチケットは 410 で、sid を発行しない", async () => {
    const { db, d1 } = makeSqliteD1();
    const env = makeEnv(d1);
    const challenge = await hashDesktopSecret(VERIFIER);
    // 発行時刻を寿命ぶん過去にずらして、期限切れの行を直接作る。
    const past = Date.now() - DESKTOP_TICKET_TTL_MS - 1;
    const deepLink = await issueDesktopTicket(d1 as D1Database, "profile-A", challenge, past);
    const ticket = ticketFromHandoffHtml(renderDesktopHandoffPage(deepLink));

    const res = await desktopAuthRoutes.request(
      `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
      {},
      env,
    );
    expect(res.status).toBe(410);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_tickets").get()).toMatchObject({
      n: 0,
    });
  });

  it("存在しないチケット・形式が壊れた入力は 400 (D1 を引く前に弾く)", async () => {
    const { d1 } = makeSqliteD1();
    const env = makeEnv(d1);

    for (const query of [
      "",
      `?ticket=${"a".repeat(43)}`, // verifier 無し
      `?verifier=${VERIFIER}`, // ticket 無し
      `?ticket=short&verifier=${VERIFIER}`,
      `?ticket=${"a".repeat(43)}&verifier=short`,
      `?ticket=${"a".repeat(43)}&verifier=${VERIFIER}`, // 形式は正しいが存在しない
    ]) {
      const res = await desktopAuthRoutes.request(`/auth/desktop/exchange${query}`, {}, env);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("発行のたびに期限切れの行が掃除される (専用の Cron を置かないための best-effort)", async () => {
    const { db, d1 } = makeSqliteD1();
    const now = Date.now();
    await issueDesktopTicket(d1 as D1Database, "profile-old", "a".repeat(64), now - 10 * 60 * 1000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_tickets").get()).toMatchObject({
      n: 1,
    });
    await issueDesktopTicket(d1 as D1Database, "profile-new", "b".repeat(64), now);
    const rows = db.prepare("SELECT profile_id FROM desktop_auth_tickets").all() as {
      profile_id: string;
    }[];
    expect(rows.map((r) => r.profile_id)).toEqual(["profile-new"]);
  });
});

describe("デスクトップ経路の add モード (プロファイル取り違えの防止)", () => {
  const VERIFIER = "3".repeat(64);
  const PROFILE_ID = "profile-A";
  const OWNER_SUB = "google-sub-owner";
  const OWNER_EMAIL = "owner@example.com";

  function seedOwner(db: DatabaseSync): void {
    db.prepare(
      "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-owner", 1, 1000);
  }

  it("POST /auth/desktop/add-intent はセッションが無ければ 401", async () => {
    const { d1 } = makeSqliteD1();
    const res = await desktopAuthRoutes.request(
      "/auth/desktop/add-intent",
      { method: "POST" },
      makeEnv(d1),
    );
    expect(res.status).toBe(401);
  });

  it(
    "webview のセッションで取った add_token を使うと、外部ブラウザ (sid 無し) でも " +
      "新規プロファイルを作らず既存プロファイルへ接続として足される",
    async () => {
      const { db, d1 } = makeSqliteD1();
      seedOwner(db);
      const env = makeEnv(d1);
      const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);

      const intentRes = await desktopAuthRoutes.request(
        "/auth/desktop/add-intent",
        { method: "POST", headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        env,
      );
      expect(intentRes.status).toBe(200);
      const { addToken } = (await intentRes.json()) as { addToken: string };

      const challenge = await hashDesktopSecret(VERIFIER);
      // 外部ブラウザからのアクセスなので Cookie は一切送らない。
      const { ticket } = await runDesktopOAuth(env, challenge, {
        sub: "google-sub-second",
        email: "second@example.com",
        query: `&add=1&add_token=${encodeURIComponent(addToken)}`,
      });

      const added = db.prepare("SELECT * FROM accounts WHERE id = ?").get("google-sub-second") as {
        profile_id: string;
        is_owner: number;
      };
      expect(added.profile_id).toBe(PROFILE_ID);
      expect(added.is_owner).toBe(0);
      // オーナー行は無傷。
      expect(db.prepare("SELECT is_owner FROM accounts WHERE id = ?").get(OWNER_SUB)).toMatchObject(
        { is_owner: 1 },
      );

      // 交換で返る sid は「足した先のプロファイル」を指す (取り違えていない)。
      const res = await desktopAuthRoutes.request(
        `/auth/desktop/exchange?ticket=${ticket}&verifier=${VERIFIER}`,
        {},
        env,
      );
      const newSid = extractCookieValue(res.headers.get("set-cookie"), SESSION_COOKIE_NAME);
      expect(await verifySessionCookieValue(SESSION_SECRET, newSid)).toBe(PROFILE_ID);
    },
  );

  it(
    "add_token が無い/壊れている状態で ?add=1 を投げても、既存プロファイルには " +
      "触らず通常ログイン (新規プロファイル) にフォールバックする",
    async () => {
      const { db, d1 } = makeSqliteD1();
      seedOwner(db);
      const env = makeEnv(d1);
      const challenge = await hashDesktopSecret(VERIFIER);

      await runDesktopOAuth(env, challenge, {
        sub: "google-sub-stranger",
        email: "stranger@example.com",
        query: "&add=1&add_token=forged",
      });

      const stranger = db
        .prepare("SELECT * FROM accounts WHERE id = ?")
        .get("google-sub-stranger") as { profile_id: string; is_owner: number };
      expect(stranger.profile_id).not.toBe(PROFILE_ID);
      expect(stranger.is_owner).toBe(1);
      expect(db.prepare("SELECT is_owner FROM accounts WHERE id = ?").get(OWNER_SUB)).toMatchObject(
        { is_owner: 1 },
      );
    },
  );
});

// --- 4. ブラウザ版/PWA の挙動が変わっていないこと ---

describe("ブラウザ経路 (回帰防止)", () => {
  it("desktop クエリを付けない /auth/login の state には desktopChallenge が載らない", async () => {
    const { d1 } = makeSqliteD1();
    const res = await authRoutes.request("/auth/login", {}, makeEnv(d1));
    const stateValue = extractCookieValue(res.headers.get("set-cookie"), STATE_COOKIE_NAME);
    // JSON にキーごと存在しないこと (= 従来と1バイトも変わらない state)。
    expect(Buffer.from(stateValue, "base64url").toString()).not.toContain("desktopChallenge");
    expect(decodeOAuthState(stateValue)).toMatchObject({ mode: "login" });
  });

  it("通常の /auth/login → /auth/callback は従来どおり sid を発行し APP_URL へ 302 する (チケットは作らない)", async () => {
    const { db, d1 } = makeSqliteD1();
    const env = makeEnv(d1);

    const loginRes = await authRoutes.request("/auth/login", {}, env);
    const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

    stubTokenFetch("google-sub-browser", "browser@example.com");
    let callbackRes: Response;
    try {
      callbackRes = await authRoutes.request(
        `/auth/callback?code=fake-code&state=${encodeURIComponent(stateValue)}`,
        { headers: { Cookie: `${STATE_COOKIE_NAME}=${stateValue}` } },
        env,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(APP_URL);
    const sid = extractCookieValue(callbackRes.headers.get("set-cookie"), SESSION_COOKIE_NAME);
    expect(await verifySessionCookieValue(SESSION_SECRET, sid)).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_tickets").get()).toMatchObject({
      n: 0,
    });
  });

  it("desktopChallenge の形式が壊れた state は不正扱い (fail closed)", () => {
    const forged = Buffer.from(
      JSON.stringify({ nonce: "n", mode: "login", desktopChallenge: "nope" }),
    ).toString("base64url");
    expect(decodeOAuthState(forged)).toBeNull();
  });
});

describe("橋渡しページ", () => {
  it("自動遷移用のリンクとフォールバックのボタンを持ち、HTML を壊さない", () => {
    const html = renderDesktopHandoffPage(buildDesktopDeepLink("abc-_123"));
    expect(html).toContain('href="kichijitsu://auth?ticket=abc-_123"');
    expect(html).toContain("認証が完了しました");
    // ディープリンクに HTML 特殊文字が混ざってもエスケープされる。
    expect(renderDesktopHandoffPage('kichijitsu://auth?ticket="><script>')).not.toContain(
      "<script>a",
    );
    expect(renderDesktopHandoffPage('kichijitsu://auth?ticket="><b>')).toContain(
      "&quot;&gt;&lt;b&gt;",
    );
  });
});
