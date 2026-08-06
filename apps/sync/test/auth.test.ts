import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  authRoutes,
  renderAddModeOwnerConflictPage,
  renderConnectionLoginRejectionPage,
} from "../src/routes/auth";
import {
  createSessionCookieValue,
  SESSION_COOKIE_NAME,
  STATE_COOKIE_NAME,
  verifySessionCookieValue,
} from "../src/session";

describe("renderConnectionLoginRejectionPage", () => {
  it("接続アカウントでのログイン拒否ページに email と APP_URL リンクを含む", () => {
    const html = renderConnectionLoginRejectionPage(
      "connected@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).toContain("connected@example.com");
    expect(html).toContain('href="https://kichijitsu.love-rox.cc"');
    expect(html).toContain("既存プロファイルの接続アカウント");
    expect(html).toContain("設定からこのアカウントの接続を解除");
  });

  it("email に HTML 特殊文字が含まれていてもエスケープしてページを壊さない", () => {
    const html = renderConnectionLoginRejectionPage(
      "<script>alert(1)</script>@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).not.toContain("<script>alert(1)</script>@example.com");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
  });
});

describe("renderAddModeOwnerConflictPage", () => {
  it("別プロファイルのオーナー衝突ページに email と APP_URL リンクを含む", () => {
    const html = renderAddModeOwnerConflictPage(
      "owner-of-another-profile@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).toContain("owner-of-another-profile@example.com");
    expect(html).toContain('href="https://kichijitsu.love-rox.cc"');
    expect(html).toContain("別のプロファイルのオーナーアカウント");
    expect(html).toContain("連携を解除");
  });

  it("email に HTML 特殊文字が含まれていてもエスケープしてページを壊さない", () => {
    const html = renderAddModeOwnerConflictPage(
      "<script>alert(1)</script>@example.com",
      "https://kichijitsu.love-rox.cc",
    );

    expect(html).not.toContain("<script>alert(1)</script>@example.com");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
  });
});

/**
 * 実際に踏まれた本番障害の経路 (2026-08-06、本番で2回発生): 設定モーダルの「再認証」/
 * 「+ アカウントを追加」ボタン (apps/web/src/components/AppOverlays.tsx の
 * onReconnectAccount / onAddAccount) は、どちらも `/auth/login?add=1` へ遷移するだけで、
 * ユーザーは自分の Google アカウント (= 既にこのプロファイルのオーナー) をそのまま
 * 選び直せてしまう。この describe は GET /auth/login?add=1 → GET /auth/callback を
 * 実際に Hono のルートへ HTTP リクエストとして通し、DB だけを (フェイクの記録係ではなく)
 * node:sqlite 上の本物の accounts テーブルに差し替えて検証する ―― ルートの配線
 * (state の encode/decode、cookie 往復、allowlist/scope 判定) と、SQL の意味論
 * (ACCOUNTS_UPSERT_SQL の is_owner 非対称 UPSERT) を、実際にユーザーが辿る経路のまま
 * 一度に確かめるため。
 */
describe("GET /auth/login?add=1 → GET /auth/callback (本番ロックアウトの再現経路)", () => {
  const SESSION_SECRET = "test-session-secret";
  const TOKEN_ENC_KEY = "ZmFrZS1rZXktZm9yLXRlc3RpbmctMzItYnl0ZXMhISE="; // 32 bytes, base64
  const OWNER_SUB = "google-sub-owner";
  const OWNER_EMAIL = "owner@example.com";
  const PROFILE_ID = "profile-A";

  /** id_token は署名検証せずデコードするだけ (google/oauth.ts decodeIdToken) なので、
   *  テストでは適当な header/signature で構わない。payload だけ実データにする。 */
  function fakeIdToken(sub: string, email: string): string {
    const base64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `${base64url({ alg: "none" })}.${base64url({ sub, email })}.sig`;
  }

  /** accounts テーブルだけを持つ本物の SQLite DB を、D1Database の最小サブセットとして
   *  ラップする (prepare().bind().first()/.all()/.run() のみ、auth.ts が使う範囲)。
   *  block-rules-route.test.ts 等の「記録するだけのフェイク」と違い、実際に SQL を
   *  実行するので UPSERT の意味論 (MAX) までこのテストで確認できる。 */
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
      CREATE UNIQUE INDEX idx_accounts_one_owner_per_profile ON accounts (profile_id) WHERE is_owner = 1;
    `);
    const d1 = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            // D1Database.bind は unknown[] を受けるが、node:sqlite の StatementSync は
            // 専用の SQLInputValue 型を要求する。このテストファイル内だけで完結する
            // D1 の最小フェイクなので、ここで一度だけ any 経由で橋渡しする。
            const sqliteParams = params as never[];
            return {
              first: async <T>() => (db.prepare(sql).get(...sqliteParams) as T | undefined) ?? null,
              all: async <T>() => ({ results: db.prepare(sql).all(...sqliteParams) as T[] }),
              run: async () => {
                db.prepare(sql).run(...sqliteParams);
                return { success: true };
              },
            };
          },
        };
      },
    };
    return { db, d1 };
  }

  function makeEnv(d1: unknown): Env {
    return {
      SESSION_SECRET,
      TOKEN_ENC_KEY,
      APP_URL: "https://kichijitsu.love-rox.cc",
      ALLOWED_EMAILS: "",
      OAUTH_REDIRECT_URL: "",
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      DB: d1,
    } as unknown as Env;
  }

  /** Set-Cookie: name=value; ... から value だけを取り出す。 */
  function extractCookieValue(setCookieHeader: string | null, name: string): string {
    if (!setCookieHeader) throw new Error("no Set-Cookie header");
    const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
    if (!match) throw new Error(`cookie ${name} not found in ${setCookieHeader}`);
    return match[1]!;
  }

  /** トークン交換 (google/oauth.ts exchangeCodeForTokens) が呼ぶ global fetch をスタブする。 */
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

  /** stubTokenFetch と同じだが、再連携で Google がよく行う「refresh_token を含めない」
   *  応答を再現する (google/oauth.ts の ExchangedTokens.refreshToken は optional)。 */
  function stubTokenFetchWithoutRefreshToken(sub: string, email: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          access_token: "at",
          expires_in: 3600,
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

  it(
    "オーナーが自分自身を「再認証」/「+アカウントを追加」で選び直しても " +
      "(?add=1 → callback) is_owner=1 のまま。以前は 1→0 に降格し、オーナー不在の " +
      "プロファイルができて誰もログインできなくなっていた (本番で2回発生)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      // 既存のオーナー行 (このプロファイルには他に接続アカウントも1件ある想定)。
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-old-encrypted", 1, 1000);
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("connected-sub", PROFILE_ID, "connected@example.com", "rt-connected", 0, 1000);

      const env = makeEnv(d1);
      const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);

      // 1. 設定モーダルの「再認証」ボタンと同じ遷移: /auth/login?add=1&login_hint=...
      const loginRes = await authRoutes.request(
        `/auth/login?add=1&login_hint=${encodeURIComponent(OWNER_EMAIL)}`,
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        env,
      );
      expect(loginRes.status).toBe(302);
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      // 2. Google からのコールバック。id_token の sub は既存オーナーと同じ Google アカウント
      //    (= 「同じアカウントを選び直しただけ」を再現)。
      stubTokenFetch(OWNER_SUB, OWNER_EMAIL);
      try {
        const callbackRes = await authRoutes.request(
          `/auth/callback?code=fake-code&state=${encodeURIComponent(stateValue)}`,
          { headers: { Cookie: `${STATE_COOKIE_NAME}=${stateValue}` } },
          env,
        );
        expect(callbackRes.status).toBe(302);
        expect(callbackRes.headers.get("location")).toBe(env.APP_URL);
      } finally {
        vi.unstubAllGlobals();
      }

      // 3. 修正の核心: オーナー行は is_owner=1 のまま。接続アカウント行にも触れていない。
      const ownerRow = db.prepare("SELECT * FROM accounts WHERE id = ?").get(OWNER_SUB) as {
        is_owner: number;
        profile_id: string;
        refresh_token: string;
      };
      expect(ownerRow.is_owner).toBe(1);
      expect(ownerRow.profile_id).toBe(PROFILE_ID);
      // トークン自体は最新へ (暗号化されて) 更新される ―― 平文 "rt-new" ではなく
      // v1: プレフィックス付きの暗号文だが、少なくとも古い値 "rt-old-encrypted" のままでは
      // ない (is_owner だけが「既存値優先」の特別扱いであることの再確認)。
      expect(ownerRow.refresh_token.startsWith("v1:")).toBe(true);
      expect(ownerRow.refresh_token).not.toBe("rt-old-encrypted");

      const connectedRow = db
        .prepare("SELECT * FROM accounts WHERE id = ?")
        .get("connected-sub") as { is_owner: number; profile_id: string };
      expect(connectedRow.is_owner).toBe(0);
      expect(connectedRow.profile_id).toBe(PROFILE_ID);
    },
  );

  it(
    "オーナー不在のプロファイルに接続しているアカウントで直接ログインすると、" +
      "拒否せずそのアカウントをオーナーに昇格させる (2026-08-06、D1 を直接触らない自力復旧)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      // このプロファイルには接続アカウントが1件あるだけで、オーナー行が無い
      // (= 過去のバグで実際に発生した「オーナー不在プロファイル」の状態そのもの)。
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("connected-sub", PROFILE_ID, "connected@example.com", "rt-connected", 0, 1000);

      const env = makeEnv(d1);

      // 通常ログイン (add=1 を付けない) ―― セッション無しでもよい。
      const loginRes = await authRoutes.request("/auth/login", {}, env);
      expect(loginRes.status).toBe(302);
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      stubTokenFetch("connected-sub", "connected@example.com");
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

      // 拒否されず (409 ではなく)、ログインが成立してセッションが発行される。
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe(env.APP_URL);
      const newSid = extractCookieValue(callbackRes.headers.get("set-cookie"), SESSION_COOKIE_NAME);
      await expect(verifySessionCookieValue(SESSION_SECRET, newSid)).resolves.toBe(PROFILE_ID);

      // アカウント行はオーナーに昇格しただけで、profile_id は変わっていない
      // (= 別プロファイルを巻き込んでいない。2026-07-21 の事故パターンとの違い)。
      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get("connected-sub") as {
        is_owner: number;
        profile_id: string;
      };
      expect(row.is_owner).toBe(1);
      expect(row.profile_id).toBe(PROFILE_ID);
    },
  );

  it(
    "オーナーが存在するプロファイルへの接続アカウント直接ログインは、引き続き拒否される " +
      "(2026-07-21 の保護がそのまま残っていることの回帰確認)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-owner", 1, 1000);
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("connected-sub", PROFILE_ID, "connected@example.com", "rt-connected", 0, 1000);

      const env = makeEnv(d1);

      const loginRes = await authRoutes.request("/auth/login", {}, env);
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      stubTokenFetch("connected-sub", "connected@example.com");
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

      expect(callbackRes.status).toBe(409);
      expect(await callbackRes.text()).toContain("既存プロファイルの接続アカウント");

      // DB は一切変更されていない。
      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get("connected-sub") as {
        is_owner: number;
        profile_id: string;
      };
      expect(row.is_owner).toBe(0);
      expect(row.profile_id).toBe(PROFILE_ID);
    },
  );

  /**
   * 「再認証したように見えて実は直っていない」バグの再現・修正確認 (2026-08-07)。
   * reauth_required_at が既に立っているアカウントで、Google が新しい refresh_token を
   * 返さなかった (再連携でよくある挙動) 場合に、死んだトークンの書き戻し・
   * reauth_required_at の消去を止められているかを、実際の /auth/login?add=1 →
   * /auth/callback 経路で確認する (「再認証」ボタンは常に add モードを使う、
   * AppOverlays.tsx 参照)。
   */
  it(
    "reauth_required_at が立っているアカウントで新しい refresh_token が得られなかった場合、" +
      "既存トークンを書き戻さず reauth_required_at も消さずにエラーページを返す",
    async () => {
      const { db, d1 } = makeSqliteD1();
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at, reauth_required_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-dead-encrypted", 1, 1000, 1_700_000_000_000);

      const env = makeEnv(d1);
      const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);

      const loginRes = await authRoutes.request(
        `/auth/login?add=1&login_hint=${encodeURIComponent(OWNER_EMAIL)}`,
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        env,
      );
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      // 「再認証」の同意画面は完走するが、Google は refresh_token を返さない
      // (最初の同意時以外は省略されることが多い)。
      stubTokenFetchWithoutRefreshToken(OWNER_SUB, OWNER_EMAIL);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      let callbackRes: Response;
      try {
        callbackRes = await authRoutes.request(
          `/auth/callback?code=fake-code&state=${encodeURIComponent(stateValue)}`,
          { headers: { Cookie: `${STATE_COOKIE_NAME}=${stateValue}` } },
          env,
        );
      } finally {
        // fetch のスタブはここで剥がすが、warnSpy はこの後の呼び出し内容の検証に使うため、
        // mockRestore (= 記録された calls もクリアしてしまう) はまだ呼ばない。
        vi.unstubAllGlobals();
      }

      // 成功 (302) 扱いにしない。生の JSON でもなく、案内 HTML を返す。
      expect(callbackRes.status).toBe(409);
      const body = await callbackRes.text();
      expect(body).toContain("再認証できませんでした");
      expect(body).toContain(OWNER_EMAIL);
      // secret はログにもレスポンスにも出さない。
      expect(body).not.toContain("rt-dead-encrypted");

      // DB は一切変更されていない: 死んだトークンは書き戻されず、
      // reauth_required_at も NULL に戻っていない。
      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(OWNER_SUB) as {
        refresh_token: string;
        reauth_required_at: number | null;
      };
      expect(row.refresh_token).toBe("rt-dead-encrypted");
      expect(row.reauth_required_at).toBe(1_700_000_000_000);

      // フォールバックが使われたことをログに残す (accountId とその事実のみ、秘密情報は出さない)。
      const warnedWithAccountId = warnSpy.mock.calls.some((args) =>
        String(args[0]).includes(OWNER_SUB),
      );
      expect(warnedWithAccountId).toBe(true);
      for (const args of warnSpy.mock.calls) {
        expect(String(args[0])).not.toContain("rt-dead-encrypted");
      }
      warnSpy.mockRestore();
    },
  );

  /**
   * 対照実験: reauth_required_at が立っていないアカウントでは、新しい refresh_token が
   * 得られなくても従来どおり既存トークンを再利用してログインが成立する (壊してはいけない
   * 既存の正常な挙動 ―― スコープ追加時の再同意など)。
   */
  it(
    "reauth_required_at が NULL のアカウントでは、新しい refresh_token が得られなくても" +
      "従来どおり既存トークンを再利用して成功する (回帰確認)",
    async () => {
      const { db, d1 } = makeSqliteD1();
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-old-encrypted", 1, 1000);

      const env = makeEnv(d1);
      const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID);

      const loginRes = await authRoutes.request(
        `/auth/login?add=1&login_hint=${encodeURIComponent(OWNER_EMAIL)}`,
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        env,
      );
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      stubTokenFetchWithoutRefreshToken(OWNER_SUB, OWNER_EMAIL);
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
      expect(callbackRes.headers.get("location")).toBe(env.APP_URL);

      const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(OWNER_SUB) as {
        refresh_token: string;
      };
      // 既存の (暗号化済み) トークンがそのまま書き戻されている (従来どおり)。
      expect(row.refresh_token).toBe("rt-old-encrypted");
    },
  );

  /**
   * このタスクの本題 (2026-08-07): 別のプロファイル (PROFILE_ID) のオーナーである
   * アカウントを、別のプロファイル (PROFILE_ID_B) に「+ アカウントを追加」で追加しようと
   * すると、以前は ACCOUNTS_UPSERT_SQL の UPSERT が
   * idx_accounts_one_owner_per_profile (部分ユニークインデックス、PROFILE_ID_B に既に
   * 別のオーナーがいる) に衝突して例外を投げ、app.onError 経由の生の 500
   * (`{"error":"internal_error"}`) が返っていた。事前チェック (isAddModeOwnerConflict)
   * で UPSERT に到達する前に検出し、案内 HTML を 409 で返すことを確認する。
   */
  it(
    "別のプロファイルのオーナーであるアカウントを add モードで追加しようとすると、" +
      "500 ではなく 409 の案内ページを返し、DB は一切変更しない",
    async () => {
      const PROFILE_ID_B = "profile-B";
      const { db, d1 } = makeSqliteD1();
      // OWNER_SUB は PROFILE_ID (A) のオーナー。
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(OWNER_SUB, PROFILE_ID, OWNER_EMAIL, "rt-owner-a-encrypted", 1, 1000);
      // PROFILE_ID_B (B) には別のオーナーが既にいる
      // (UNIQUE 制約に実際に衝突する状況を再現する)。
      db.prepare(
        "INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("owner-b-sub", PROFILE_ID_B, "owner-b@example.com", "rt-owner-b-encrypted", 1, 1000);

      const env = makeEnv(d1);
      // 利用者は今プロファイル B にログイン中で、「+ アカウントを追加」から
      // (別プロファイル A のオーナーである) OWNER_SUB を選ぶ。
      const sid = await createSessionCookieValue(SESSION_SECRET, PROFILE_ID_B);

      const loginRes = await authRoutes.request(
        `/auth/login?add=1&login_hint=${encodeURIComponent(OWNER_EMAIL)}`,
        { headers: { Cookie: `${SESSION_COOKIE_NAME}=${sid}` } },
        env,
      );
      expect(loginRes.status).toBe(302);
      const stateValue = extractCookieValue(loginRes.headers.get("set-cookie"), STATE_COOKIE_NAME);

      stubTokenFetch(OWNER_SUB, OWNER_EMAIL);
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

      // 生の 500/JSON ではなく、意味の分かる 409 の案内ページ。
      expect(callbackRes.status).toBe(409);
      const body = await callbackRes.text();
      expect(body).toContain("別のプロファイルのオーナーアカウント");
      expect(body).toContain(OWNER_EMAIL);

      // DB は一切変更されていない: A のオーナー行も B のオーナー行もそのまま。
      const ownerARow = db.prepare("SELECT * FROM accounts WHERE id = ?").get(OWNER_SUB) as {
        profile_id: string;
        is_owner: number;
        refresh_token: string;
      };
      expect(ownerARow.profile_id).toBe(PROFILE_ID);
      expect(ownerARow.is_owner).toBe(1);
      expect(ownerARow.refresh_token).toBe("rt-owner-a-encrypted");

      const ownerBRow = db.prepare("SELECT * FROM accounts WHERE id = ?").get("owner-b-sub") as {
        profile_id: string;
        is_owner: number;
      };
      expect(ownerBRow.profile_id).toBe(PROFILE_ID_B);
      expect(ownerBRow.is_owner).toBe(1);
    },
  );
});
