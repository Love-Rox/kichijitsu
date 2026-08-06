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
import {
  isAddModeOwnerConflict,
  isProfileOwnerless,
  resolveLoginProfile,
} from "../profile-resolution";
import { shouldRejectStaleRefreshTokenReuse } from "../core/reauth";
// デスクトップ版 (Tauri) の外部ブラウザ OAuth 経路 (2026-08-07)。既存の login/add の流れを
// 壊さないため、新経路の実装は routes/desktop-auth.ts + core/desktop-auth.ts に切り出し、
// このファイルからは「challenge を state に載せる」「callback の最後を委ねる」だけ呼ぶ。
import { parseDesktopLoginChallenge, verifyDesktopAddToken } from "../core/desktop-auth";
import { issueDesktopTicket, renderDesktopHandoffPage } from "./desktop-auth";

export const authRoutes = new Hono<AppEnv>();

/**
 * accounts の UPSERT 本体 (/auth/callback の最後で使う)。export しているのは
 * test/accounts-owner-upsert.test.ts が node:sqlite 上でこの文字列そのものを実行し、
 * D1 (SQLite) 上で `is_owner = MAX(is_owner, excluded.is_owner)` が意図どおり
 * (既存行が既にオーナーなら降格しない) 動くことを検証するため ―― テスト側で SQL 文字列を
 * 手で複製すると、将来ここを直したときにテストだけが古い書き方のまま通ってしまう
 * (=検証が形骸化する) ので、必ずこの定数を import させて一致を強制する。
 */
export const ACCOUNTS_UPSERT_SQL = `
  INSERT INTO accounts (id, profile_id, email, refresh_token, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    profile_id = excluded.profile_id,
    email = excluded.email,
    refresh_token = excluded.refresh_token,
    is_owner = MAX(is_owner, excluded.is_owner),
    reauth_required_at = NULL
`;

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

/**
 * 再認証待ち (accounts.reauth_required_at 非 NULL、core/reauth.ts の
 * shouldRejectStaleRefreshTokenReuse を参照) のアカウントで、Google から新しい
 * refresh_token を受け取れなかったときに返す案内ページ (2026-08-07)。
 *
 * ここで生の JSON エラーを返すと「同意画面は完走したのに何が起きたか分からない」まま
 * 終わってしまう (実際に本番でこの状態が「直ったように見えて数分後にまた壊れる」
 * ループとして観測された)。renderConnectionLoginRejectionPage と同じ作法で、
 * 何が起きたか・次に何を試せばよいかが分かる HTML を返す。
 */
export function renderReauthFailedPage(email: string, appUrl: string): string {
  const safeEmail = escapeHtml(email);
  const safeAppUrl = escapeHtml(appUrl);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>再認証できませんでした - kichijitsu</title>
  </head>
  <body>
    <h1>再認証できませんでした</h1>
    <p>このアカウント (${safeEmail}) について、Google から新しいアクセス許可を取得できませんでした。同意画面を完了したように見えても、Google が新しい許可の発行をスキップした可能性があります。</p>
    <p>もう一度「再認証」をお試しください。それでも解決しない場合は、
      <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google アカウントのアクセス権限の管理</a>
      からこのアプリへのアクセスを一度削除したうえで、改めて連携し直してください。</p>
    <p><a href="${safeAppUrl}">トップページに戻る</a></p>
  </body>
</html>
`;
}

/**
 * add モード (`?add=1`、「+ アカウントを追加」) で選んだ Google アカウントが、既に
 * 「別の」プロファイルのオーナーだったときに返す案内ページ (2026-08-07)。
 *
 * この拒否自体は正しい動作 (profile-resolution.ts の isAddModeOwnerConflict のコメント
 * 参照): 通させると UNIQUE 制約違反で 500 になるか、衝突しなくても元のプロファイルが
 * オーナー不在になる。以前は事前チェックが無く、UPSERT が例外を投げて生の
 * `{"error":"internal_error"}` が表示されていた。ここでは UPSERT に到達する前に検出し、
 * renderConnectionLoginRejectionPage / renderReauthFailedPage と同じ作法
 * (エスケープ済み HTML、生の JSON を返さない) で「なぜ」と「どうすればよいか」を伝える。
 *
 * 利用者は「自分の Google アカウントなのになぜ追加できないのか」が直感的に分からない
 * ため、「1つの Google アカウントは同時に1つのプロファイルのオーナーにしかなれない」
 * という前提そのものを文中で明示する。
 */
export function renderAddModeOwnerConflictPage(email: string, appUrl: string): string {
  const safeEmail = escapeHtml(email);
  const safeAppUrl = escapeHtml(appUrl);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>接続アカウントとして追加できません - kichijitsu</title>
  </head>
  <body>
    <h1>接続アカウントとして追加できません</h1>
    <p>このアカウント (${safeEmail}) は、既に別のプロファイルのオーナーアカウントです。1つの Google アカウントは同時に1つのプロファイルのオーナーにしかなれないため、今開いているプロファイルへ接続アカウントとして追加することはできません。</p>
    <p>このアカウントをこちらのプロファイルに追加したい場合は、まずオーナーになっている元のプロファイルにログインし、設定からこのアカウントの連携を解除してください。そのうえで、改めてこちらのプロファイルの「+ アカウントを追加」からやり直してください。</p>
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
  // 再連携の導線 (SettingsModal → App.tsx) が対象アカウントのメールを login_hint に載せてくる。
  // Google 側でそのアカウントを事前選択させるため buildAuthorizationUrl へ渡す (値があるときだけ)。
  const loginHint = c.req.query("login_hint");
  // デスクトップ版 (Tauri) が**外部ブラウザ**で始めた OAuth かどうか (2026-08-07)。
  // `desktop=1` + 正しい形式の `dc` が両方そろったときだけ非 null になる。ブラウザ版/PWA は
  // このクエリを一切付けないので常に null = 以下の分岐はすべて従来どおりに流れる。
  // 経緯とチケット設計は core/desktop-auth.ts / routes/desktop-auth.ts の冒頭コメント参照。
  const desktopChallenge = parseDesktopLoginChallenge(c.req.query("desktop"), c.req.query("dc"));
  let addModeProfileId: string | null = null;
  if (wantsAddMode) {
    if (desktopChallenge) {
      // 外部ブラウザには webview の sid cookie が無い。代わりに webview 側で
      // POST /auth/desktop/add-intent から取った短命の署名付きトークンでプロファイルを決める
      // (これが無いと「add のつもりが新規プロファイル作成」= アカウント取り違えになる)。
      addModeProfileId = await verifyDesktopAddToken(
        c.env.SESSION_SECRET,
        c.req.query("add_token") ?? "",
      );
    } else {
      const sid = getCookie(c, SESSION_COOKIE_NAME);
      if (sid) {
        addModeProfileId = await verifySessionCookieValue(c.env.SESSION_SECRET, sid);
      }
    }
  }

  const nonce = crypto.randomUUID();
  // desktopChallenge が null のときは JSON.stringify がキーごと落とすので、ブラウザ版が
  // 発行する state は従来と完全に同じ (oauth-state.ts のコメント参照)。
  const state = encodeOAuthState(
    addModeProfileId
      ? {
          nonce,
          mode: "add",
          profileId: addModeProfileId,
          desktopChallenge: desktopChallenge ?? undefined,
        }
      : { nonce, mode: "login", desktopChallenge: desktopChallenge ?? undefined },
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
    loginHint,
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
  // reauth_required_at もここで併せて取得する (2026-08-07): 下の refreshTokenToStore
  // フォールバック判定 (shouldRejectStaleRefreshTokenReuse) に必要。
  const existing = await c.env.DB.prepare(
    "SELECT profile_id, refresh_token, is_owner, reauth_required_at FROM accounts WHERE id = ?",
  )
    .bind(accountId)
    .first<{
      profile_id: string;
      refresh_token: string;
      is_owner: number;
      reauth_required_at: number | null;
    }>();

  // プロファイルの決め方 (2026-07-20, アカウント設計の分離: 身元(オーナー) と 同期アカウント
  // (接続) を分ける。詳細は src/profile-resolution.ts のコメント参照):
  //
  // - add モード (`?add=1`、有効なセッションが必要): state に載っている (今ログイン中の)
  //   プロファイルに、このアカウントを「接続」(is_owner=0) として追加する。ただし、
  //   選んだ Google アカウントが既に「別の」プロファイルのオーナーだった場合は追加せず、
  //   案内ページを返して拒否する (下記 2026-08-07 参照)。同じプロファイルのオーナーを
  //   選び直した場合 (再認証の経路) は矛盾しないのでそのまま通す。
  //   矛盾ケース: accounts.id (= Google sub) が PK のままなので、1つの Google アカウントは
  //   常にどこか1つのプロファイルにしか属せない。したがって、元プロファイルのオーナー
  //   だったアカウントを他プロファイルへ「接続」として付け替えると、元プロファイルは
  //   オーナー不在 (0 件) になり、元プロファイルに残っていた他の接続アカウントは
  //   宙に浮く (どのプロファイルにも属さないわけではないが、ログインで復元できるオーナーが
  //   いなくなる)。「同一 sub が複数プロファイルに接続として存在し得る」設計
  //   (=(profile_id, sub) 複合キー化) は別途の大改修が必要なため、今回もそこまでは
  //   行わず、矛盾する付け替えそのものを拒否する最小変更に留める (下記 2026-08-07 参照)。
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
  //
  //   2026-08-06 に本番でさらに別の事故が2回発生した: add モードの UPSERT (下記) が
  //   `is_owner = excluded.is_owner` で既存のオーナー行を無条件に上書きしていたため、
  //   「+ アカウントを追加」や「再認証」でオーナー自身の Google アカウントを選ぶと
  //   is_owner が 1→0 に降格し、オーナー不在のプロファイルができていた。オーナー不在に
  //   なると、上の分岐ルール (reject-connection-login) により**そのプロファイルの誰も
  //   二度とログインできなくなる** (D1 を直接触る以外に復旧手段が無い)。
  //   これを受けて (1) UPSERT 側で is_owner を「既存値と新しい値の MAX」に変更し
  //   そもそも降格が起きないようにし、(2) 万一オーナー不在のプロファイルが存在しても
  //   利用者が自力で復旧できるよう、接続アカウントでの login を「オーナー不在の場合に
  //   限り」許可してそのアカウントを昇格させる (`promote-to-owner`) セーフティネットを
  //   追加した。詳細と「2026-07-21 の事故を再発させない理由」は src/profile-resolution.ts
  //   のコメント参照。
  //
  //   2026-08-07 にさらに1件: MAX() 化 (上記) 自体は正しい防御だったが、「別の」
  //   プロファイルのオーナーであるアカウントを add モードで選んだときに、UPSERT が
  //   `idx_accounts_one_owner_per_profile` (部分ユニークインデックス) に衝突して例外を
  //   投げ、`app.onError` 経由の生の 500 (`{"error":"internal_error"}`) が利用者に
  //   見えてしまっていた。拒否自体は正しい (通せば 500 になるか、衝突しなくても元の
  //   プロファイルがオーナー不在になる)。UPSERT や UNIQUE 制約の例外に頼ると SQLite の
  //   エラーメッセージ文字列に結合してしまうため、below の isAddModeOwnerConflict で
  //   UPSERT に到達する前に事前チェックし、意味の分かる案内ページ
  //   (renderAddModeOwnerConflictPage) を返すようにした。
  let profileId: string;
  if (state.mode === "add") {
    if (
      existing &&
      isAddModeOwnerConflict({
        existingProfileId: existing.profile_id,
        existingIsOwner: existing.is_owner === 1,
        targetProfileId: state.profileId,
      })
    ) {
      // 別プロファイルのオーナーだった場合のみここで止める。同じプロファイルの
      // オーナーを選び直した場合 (existing.profile_id === state.profileId、再認証の
      // 経路) は isAddModeOwnerConflict が false を返すのでここは通過し、従来どおり
      // UPSERT まで進む。
      return c.html(renderAddModeOwnerConflictPage(email, c.env.APP_URL), 409);
    }
    profileId = state.profileId;
  } else {
    // 接続アカウント (is_owner=0) の場合だけ、接続先プロファイルにオーナーが
    // 1人もいないかを確認する (promote-to-owner の判定材料。オーナーが既にいる
    // プロファイルではこの問い合わせ自体が無駄なので、その場合はスキップする)。
    let connectedProfileHasNoOwner = false;
    if (existing && existing.is_owner === 0) {
      const { results: siblingAccounts } = await c.env.DB.prepare(
        "SELECT is_owner FROM accounts WHERE profile_id = ?",
      )
        .bind(existing.profile_id)
        .all<{ is_owner: number }>();
      connectedProfileHasNoOwner = isProfileOwnerless(
        siblingAccounts.map((row) => ({ isOwner: row.is_owner === 1 })),
      );
    }

    const resolution = resolveLoginProfile(
      existing ? { profileId: existing.profile_id, isOwner: existing.is_owner === 1 } : null,
      crypto.randomUUID(),
      connectedProfileHasNoOwner,
    );
    if (resolution.kind === "reject-connection-login") {
      // 接続アカウント (is_owner=0) での直接ログインは拒否する。refresh_token の
      // 保存はもちろん、accounts 行の書き換えも一切行わない (email はここまでで OAuth
      // から取得済みの値をそのまま案内に使うだけ)。
      return c.html(renderConnectionLoginRejectionPage(email, c.env.APP_URL), 409);
    }
    // resolution.kind は restore-owner-profile / new-profile / promote-to-owner のいずれか。
    // promote-to-owner でも profileId は既存の (= このアカウントが元々属していた)
    // プロファイルのままで、下の isOwner 計算 (login モードは常に 1) が実際の昇格
    // (is_owner 0→1) を行う。他のアカウント行やプロファイルには一切触れない。
    profileId = resolution.profileId;
  }
  // login モードでは、ログインに使ったアカウント自身が常にそのプロファイルのオーナー
  // (既存のオーナー行を維持する場合も、新規プロファイルを作る場合も is_owner=1)。
  // add モードで追加されるアカウントは常に「接続」(is_owner=0)。
  const isOwner = state.mode === "add" ? 0 : 1;

  // 再認証待ち (reauth_required_at 非 NULL) のアカウントで、Google が新しい
  // refresh_token を返さなかった場合はここで打ち切る (2026-08-07、核心の修正)。
  // 詳しい経緯は core/reauth.ts の shouldRejectStaleRefreshTokenReuse を参照。
  // UPSERT (ACCOUNTS_UPSERT_SQL、reauth_required_at を無条件 NULL に戻す) に到達させず、
  // 死んでいると分かっている既存トークンも書き戻さない ―― どちらもここで止めないと
  // 「再認証したように見えて実は直っていない」まま reauth_required_at だけ消えてしまう。
  const reauthRequiredAt = existing?.reauth_required_at ?? null;
  const hasNewRefreshToken = Boolean(tokens.refreshToken);
  if (shouldRejectStaleRefreshTokenReuse(hasNewRefreshToken, reauthRequiredAt)) {
    // accountId と「新しい refresh_token が返らなかった」事実のみ記録する。
    // トークン (既存値・新規値とも) やその一部は絶対に出さない。
    console.warn(
      `auth callback: reauth required for account ${accountId} but Google did not return a new refresh_token; refusing to reuse the stale stored token`,
    );
    return c.html(renderReauthFailedPage(email, c.env.APP_URL), 409);
  }

  // Google から新しい平文 refresh_token を受け取った時だけ暗号化する。既存行を使い回す
  // 場合は D1 に入っている値 (= 既に v1 暗号文、または移行対象外の旧平文) をそのまま書き戻す
  // だけなので、ここで復号する必要はない。
  if (!hasNewRefreshToken && existing?.refresh_token) {
    // このフォールバック自体が黙って動くと発見が遅れる (今回の不具合そのもの) ので、
    // 使われたことを常にログへ残す。ここに来る時点で reauthRequiredAt は null
    // (非 null は上のガードで既に弾いている) ―― 正常系のフォールバックであることの記録。
    console.warn(
      `auth callback: no new refresh_token from Google for account ${accountId}; reusing the stored token`,
    );
  }
  const refreshTokenToStore = tokens.refreshToken
    ? await encryptToken(c.env.TOKEN_ENC_KEY, tokens.refreshToken)
    : existing?.refresh_token;
  if (!refreshTokenToStore) {
    return c.json({ error: "missing_refresh_token" }, 502);
  }

  // reauth_required_at (2026-08-06、恒久的なリフレッシュ失敗の記録、migrations/0013 参照) は
  // ここで無条件に NULL へ戻す。ここに来ている時点で Google の OAuth 同意フローを新しく
  // 完走できている = 再認証は成功しているので、確実に消してよい。UserSyncDO 側の
  // getOrRefreshAccessToken でも成功時に同じ列を消すが、DO の access_token キャッシュが
  // まだ有効な間はそちらを通らずに再連携が完了してしまい、その間 UI に警告が残り続ける
  // (再連携直後に「同期が止まっています」が消えない) ため、ここで即座に消すのが主経路。
  //
  // is_owner だけ他の列と非対称な扱いをしている (2026-08-06、本番で2回発生した
  // ロックアウト事故の修正): `is_owner = MAX(is_owner, excluded.is_owner)` にして、
  // 既存行が既にオーナー (1) なら新しい値が 0 でもそのまま 1 を維持する。
  // - profile_id / email / refresh_token は「常に最新の値で上書きしてよい」列 ――
  //   add モードは「このアカウントをこのプロファイルへ接続として足す/繋ぎ直す」意図で、
  //   その意図どおり最新の入力値をそのまま反映するのが正しい。
  // - is_owner は逆で、「挿入時 (INSERT) は正しい値だが、更新時 (UPDATE) には
  //   呼び出し元の isOwner がそのまま正しいとは限らない」列。add モードは常に
  //   isOwner=0 を渡すが、それは「(このアカウントがオーナーでなければ) 接続として
  //   足す」という意図であって、「既にオーナーである行の身分を奪う」意図では断じてない。
  //   ところが `is_owner = excluded.is_owner` という素直な上書きは、まさにその意図しない
  //   降格を機械的に行ってしまっていた ―― オーナー自身が「再認証」や「+ アカウントを
  //   追加」ボタンを押すだけ (画面上は何の警告も出ない) で is_owner が 1→0 になり、
  //   オーナー不在のプロファイル (誰もログインできない = D1 を直接叩く以外に復旧手段が
  //   無い) が本番で2回できてしまった。MAX() は「一度オーナーになった行は、この UPSERT
  //   経由では絶対に降格しない」を SQL レベルでそのまま表現できる、最小かつ意図の
  //   明確な書き方として採用した (login モードで新規プロファイルを作る/オーナーに
  //   昇格させるときは isOwner=1 を渡すので、MAX() でも 0→1 の昇格は問題なく起きる)。
  //   D1 (SQLite) の UPSERT で `DO UPDATE SET col = MAX(col, excluded.col)` の
  //   `col`(無修飾) が「上書き前の既存行の値」を指すことは test/accounts-owner-upsert.test.ts
  //   で node:sqlite を使い実際に検証している。
  await c.env.DB.prepare(ACCOUNTS_UPSERT_SQL)
    .bind(accountId, profileId, email, refreshTokenToStore, isOwner, Date.now())
    .run();

  // デスクトップ版 (外部ブラウザ経路、2026-08-07): ここは**外部ブラウザ**なので、
  // sid cookie を張ってもアプリの webview には届かない (Cookie ジャーが別)。
  // 代わりに使い捨てチケットを発行し、kichijitsu:// でアプリへ橋渡しする。
  // 実際に sid を発行するのは、アプリの webview 自身が踏む /auth/desktop/exchange。
  // login/add どちらのモードでも同じ ―― add モードでも webview 側は同じプロファイルの
  // sid を張り直すだけなので、既存セッションと矛盾しない。
  if (state.desktopChallenge) {
    const deepLink = await issueDesktopTicket(c.env.DB, profileId, state.desktopChallenge);
    return c.html(renderDesktopHandoffPage(deepLink));
  }

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
