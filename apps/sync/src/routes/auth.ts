import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import {
  STATE_COOKIE_MAX_AGE,
  STATE_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
  verifySessionCookieValue,
} from "../session";
import {
  buildAuthorizationUrl,
  decodeIdToken,
  exchangeCodeForTokens,
  hasRequiredScopes,
} from "../google/oauth";
import { isHttpsRequest } from "../http";
import { isEmailAllowed } from "../allowlist";
import { encryptToken } from "../crypto";
import { encodeOAuthState, decodeOAuthState } from "../oauth-state";
import { resolveLoginProfile } from "../profile-resolution";

export const authRoutes = new Hono<AppEnv>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * login モードで「接続アカウント (is_owner=0) によるログイン」を拒否したときに返す
 * 案内ページ。email は Google の ID トークンから取ったもの (このアプリの入力ではないが、
 * 万一 `<`/`&` 等を含んでいてもレスポンス HTML を壊さないよう escapeHtml を通す)。
 */
export function renderConnectionLoginRejectionPage(email: string, appUrl: string): string {
  const safeEmail = escapeHtml(email);
  const safeAppUrl = escapeHtml(appUrl);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>ログインできません - kichijitsu</title>
  </head>
  <body>
    <h1>ログインできません</h1>
    <p>このアカウント (${safeEmail}) は既存プロファイルの接続アカウントです。プロファイルのオーナーアカウントでログインしてください。</p>
    <p>このアカウントを独立したプロファイルにしたい場合は、先にオーナーでログインして設定からこのアカウントの接続を解除してください。</p>
    <p><a href="${safeAppUrl}">トップページに戻る</a></p>
  </body>
</html>
`;
}

function redirectUriFor(env: { OAUTH_REDIRECT_URL?: string }, requestUrl: string): string {
  // 通常はリクエスト URL から導出する (本番では https://kichijitsu.love-rox.cc/auth/callback)。
  // ただし wrangler dev は wrangler.jsonc に routes があるとリクエスト URL を本番ルートの
  // ホスト (http://kichijitsu.love-rox.cc/...) でシミュレートするため、そのまま使うと
  // redirect_uri_mismatch になる。ローカルでは .dev.vars の OAUTH_REDIRECT_URL
  // (http://localhost:8787/auth/callback) で明示上書きする。空文字は未設定扱い。
  if (env.OAUTH_REDIRECT_URL) return env.OAUTH_REDIRECT_URL;
  return new URL("/auth/callback", requestUrl).toString();
}

authRoutes.get("/auth/login", async (c) => {
  // ?add=1 は「今のセッション (プロファイル) にアカウントを追加する」モード。
  // 有効なセッションが無ければ通常ログインにフォールバックする (新規プロファイルを作る)。
  const wantsAddMode = c.req.query("add") === "1";
  let addModeProfileId: string | null = null;
  if (wantsAddMode) {
    const sid = getCookie(c, SESSION_COOKIE_NAME);
    if (sid) {
      addModeProfileId = await verifySessionCookieValue(c.env.SESSION_SECRET, sid);
    }
  }

  const nonce = crypto.randomUUID();
  const state = encodeOAuthState(
    addModeProfileId
      ? { nonce, mode: "add", profileId: addModeProfileId }
      : { nonce, mode: "login" },
  );

  // 本番 (https://kichijitsu.love-rox.cc) では Secure を付け、ローカル `wrangler dev`
  // (素の http://localhost) では付けない。Secure な Cookie は非 HTTPS ではブラウザに
  // 保存されない実装もあるため、リクエストのスキームで動的に切り替える。
  setCookie(c, STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: isHttpsRequest(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_COOKIE_MAX_AGE,
  });

  const authorizationUrl = buildAuthorizationUrl(
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.env, c.req.url),
    },
    state,
  );

  return c.redirect(authorizationUrl, 302);
});

authRoutes.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const oauthError = c.req.query("error");
  const cookieState = getCookie(c, STATE_COOKIE_NAME);
  deleteCookie(c, STATE_COOKIE_NAME, { path: "/" });

  if (oauthError) {
    return c.json({ error: `google_oauth_error: ${oauthError}` }, 400);
  }
  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }
  const state = decodeOAuthState(cookieState);
  if (!state) {
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  const tokens = await exchangeCodeForTokens(
    fetch,
    {
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: redirectUriFor(c.env, c.req.url),
    },
    code,
  );
  if (!tokens.idToken) {
    return c.json({ error: "missing_id_token" }, 502);
  }

  if (!hasRequiredScopes(tokens.scope)) {
    // granular consent でユーザーがカレンダー系スコープの一部/全部を外した場合。
    // accountId/email 抜きで判定できるので decodeIdToken より前でチェックし、accounts への
    // 保存 (refresh_token を含む) は一切行わずに弾く。allowlist / scope 検査はアカウント
    // 単位で行う (login/add どちらのモードでも同じ)。
    const deniedUrl = new URL(c.env.APP_URL);
    deniedUrl.searchParams.set("auth_error", "insufficient_scope");
    return c.redirect(deniedUrl.toString(), 302);
  }

  const { sub: accountId, email } = decodeIdToken(tokens.idToken);

  if (!isEmailAllowed(c.env.ALLOWED_EMAILS, email)) {
    // 招待制 allowlist に無いメールアドレス。accounts への保存 (特に refresh_token) を
    // 一切行わずに弾く — 未招待ユーザーの Google トークンをサーバーに残さないため。
    const deniedUrl = new URL(c.env.APP_URL);
    deniedUrl.searchParams.set("auth_error", "not_invited");
    return c.redirect(deniedUrl.toString(), 302);
  }

  // 再連携で Google が refresh_token を返さないことがある (通常は最初の同意時のみ発行)。
  // その場合は既存の (暗号化済み) refresh_token をそのまま再利用する。is_owner も
  // 「このアカウントが既にどこかのプロファイルのオーナーか」の判定に使う。
  const existing = await c.env.DB.prepare(
    "SELECT profile_id, refresh_token, is_owner FROM accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<{ profile_id: string; refresh_token: string; is_owner: number }>();

  // プロファイルの決め方 (2026-07-20, アカウント設計の分離: 身元(オーナー) と 同期アカウント
  // (接続) を分ける。詳細は src/profile-resolution.ts のコメント参照):
  //
  // - add モード (`?add=1`、有効なセッションが必要): state に載っている (今ログイン中の)
  //   プロファイルに、このアカウントを「接続」(is_owner=0) として追加する。既にこの
  //   Google アカウントが別プロファイルのオーナーだった場合でも、今回の OAuth 同意で
  //   本人確認は取れているのでそのまま付け替える (アカウントの持ち主が自分の意思で行う
  //   操作として正当な移動として扱う)。
  //   矛盾ケース: accounts.id (= Google sub) が PK のままなので、1つの Google アカウントは
  //   常にどこか1つのプロファイルにしか属せない。したがって、元プロファイルのオーナー
  //   だったアカウントを他プロファイルへ「接続」として付け替えると、元プロファイルは
  //   オーナー不在 (0 件) になり、元プロファイルに残っていた他の接続アカウントは
  //   宙に浮く (どのプロファイルにも属さないわけではないが、ログインで復元できるオーナーが
  //   いなくなる)。今回のスコープでは検出・防止しない — 「同一 sub が複数プロファイルに
  //   接続として存在し得る」設計 (=(profile_id, sub) 複合キー化) は別途の大改修が必要なため
  //   最小変更に留める。
  //
  // - login モード (通常、add でない): このアカウントが「どこかのプロファイルのオーナー」
  //   なら、そのプロファイルへログインする (= 自分の身元で戻ってきた)。未連携の新規
  //   アカウントなら、このアカウント自身をオーナーとする新規プロファイルを作る。
  //   他プロファイルへの「接続」(is_owner=0) に過ぎないアカウントの場合は、ログインを
  //   拒否する (プロファイルもアカウント行も一切変更しない)。
  //
  //   2026-07-20 に一度、「オーナーでないなら新規プロファイルを作る」に直した (それまでは
  //   `existing?.profile_id` をそのまま採用しており、接続アカウントでログインすると
  //   その接続先プロファイルの束が丸ごと復活してしまっていた)。しかしこの「新規プロファイル
  //   を作る」対応にも欠陥が残っていた: 下の UPSERT は accounts.id (PK) 単位で
  //   profile_id/is_owner を上書きするため、既存の接続アカウント行を元プロファイルから
  //   新プロファイルへ引き剥がしてしまう。元プロファイル (別端末でログイン中の可能性がある)
  //   はそのアカウントを失いカレンダーが消え、新端末は空プロファイルになる、という事故が
  //   2026-07-21 に本番で実際に発生した (今回のバグの本体)。
  //
  //   そのため 2026-07-21 に再修正: 接続アカウントでの login はプロファイル解決自体を
  //   せず (`reject-connection-login`)、UPSERT にも到達させずにここでエラーページを返す。
  //   詳細な分岐ルールは src/profile-resolution.ts のコメント参照。
  let profileId: string;
  if (state.mode === "add") {
    profileId = state.profileId;
  } else {
    const resolution = resolveLoginProfile(
      existing ? { profileId: existing.profile_id, isOwner: existing.is_owner === 1 } : null,
      crypto.randomUUID(),
    );
    if (resolution.kind === "reject-connection-login") {
      // 接続アカウント (is_owner=0) での直接ログインは拒否する。refresh_token の
      // 保存はもちろん、accounts 行の書き換えも一切行わない (email はここまでで OAuth
      // から取得済みの値をそのまま案内に使うだけ)。
      return c.html(renderConnectionLoginRejectionPage(email, c.env.APP_URL), 409);
    }
    profileId = resolution.profileId;
  }
  // login モードでは、ログインに使ったアカウント自身が常にそのプロファイルのオーナー
  // (既存のオーナー行を維持する場合も、新規プロファイルを作る場合も is_owner=1)。
  // add モードで追加されるアカウントは常に「接続」(is_owner=0)。
  const isOwner = state.mode === "add" ? 0 : 1;

  // Google から新しい平文 refresh_token を受け取った時だけ暗号化する。既存行を使い回す
  // 場合は D1 に入っている値 (= 既に v1 暗号文、または移行対象外の旧平文) をそのまま書き戻す
  // だけなので、ここで復号する必要はない。
  const refreshTokenToStore = tokens.refreshToken
    ? await encryptToken(c.env.TOKEN_ENC_KEY, tokens.refreshToken)
    : existing?.refresh_token;
  if (!refreshTokenToStore) {
    return c.json({ error: "missing_refresh_token" }, 502);
  }

  await c.env.DB.prepare(
    `INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, email = excluded.email, refresh_token = excluded.refresh_token, is_owner = excluded.is_owner`,
  )
    .bind(accountId, profileId, email, refreshTokenToStore, isOwner, Date.now())
    .run();

  if (state.mode !== "add") {
    // add モードでは既存セッションをそのまま使うので、新しい sid は発行しない
    // (「新セッションを作らない」)。
    const sessionValue = await createSessionCookieValue(c.env.SESSION_SECRET, profileId);
    setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: isHttpsRequest(c.req.url),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE,
    });
  }

  return c.redirect(c.env.APP_URL, 302);
});

// 認証不要 (sid が無くても/無効でも成功扱い): ログアウトは「もう sid を持っていない状態」が
// ゴールなので、既に未認証でも 204 を返してよい。
//
// CSRF: POST + SameSite=Lax の組み合わせで十分。SameSite=Lax は cross-site の POST では
// Cookie を送らない (許可されるのはトップレベル navigation の GET のみ) ため、他サイトの
// フォーム/fetch からこのエンドポイントを叩いても sid が付与されず、ログアウトはできても
// 「他人を強制ログアウトさせる」以上の実害 (なりすまし等) が起きない。GET にしないのは
// ブラウザのプリフェッチや <img src> のような偶発的な GET でログアウトが誘発されるのを防ぐため。
authRoutes.post("/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.body(null, 204);
});
