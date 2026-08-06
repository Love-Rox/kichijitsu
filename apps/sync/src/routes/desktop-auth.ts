import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import {
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  createSessionCookieValue,
  verifySessionCookieValue,
} from "../session";
import { isHttpsRequest } from "../http";
import {
  DESKTOP_TICKET_TTL_MS,
  buildDesktopDeepLink,
  createDesktopAddToken,
  generateDesktopTicket,
  hashDesktopSecret,
  isDesktopTicketFresh,
  isValidDesktopHex32,
  isValidDesktopTicketFormat,
  timingSafeEqualString,
} from "../core/desktop-auth";

/**
 * デスクトップ版 (Tauri) の外部ブラウザ OAuth の**配線**部分 (2026-08-07)。
 * 判定・生成・検証のロジックは core/desktop-auth.ts の純関数側にあり、そちらに
 * 「なぜ外部ブラウザなのか」「チケットの安全性をどう担保しているか」を全部書いてある。
 *
 * # 全体の流れ
 * ```
 * [アプリ webview]  「Google 連携」クリック
 *        │  (add モードのみ) POST /auth/desktop/add-intent → 署名付き add_token
 *        ▼  invoke("open_external_login", { path: "/auth/login?..." })
 * [Rust]  verifier を自分の中に保持し、challenge=SHA-256(verifier) を URL に足して
 *        │  OS の既定ブラウザで開く
 *        ▼
 * [外部ブラウザ]  /auth/login?...&desktop=1&dc=<challenge> → Google 同意 → /auth/callback
 *        │  (routes/auth.ts の末尾) チケットを発行し kichijitsu:// へ橋渡しするページを返す
 *        ▼
 * [OS]   kichijitsu://auth?ticket=... をアプリへ配送
 *        ▼
 * [Rust]  保持していた verifier を添えて webview を
 *        │  /auth/desktop/exchange?ticket=..&verifier=.. へナビゲートする
 *        ▼
 * [Worker] チケットを消費し、**webview の Cookie として** sid を発行して APP_URL へ戻す
 * ```
 *
 * なぜ最後を「webview のナビゲーション」にしたか: `Set-Cookie` はレスポンスを受け取った
 * Cookie ジャーにしか入らない。アプリの webview 自身にこの GET を踏ませるのが、
 * webview の Cookie ジャーへ sid を確実に入れる唯一素直な方法だから (Rust から fetch して
 * Cookie を手で移す、といった細工が要らない)。
 *
 * このファイルを routes/auth.ts と分けているのは、既存の login/add・state 検証・
 * prompt=consent・login_hint の流れに手を入れる量を最小にするため (auth.ts 側の変更は
 * 「challenge を state に載せる」「desktop なら最後にこちらへ委ねる」の2点だけ)。
 */
export const desktopAuthRoutes = new Hono<AppEnv>();

/** routes/auth.ts の同名関数と同じ (このファイルだけで完結させるための小さな写し)。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 外部ブラウザで OAuth が完了したあとに表示する「アプリへ戻る」ページ。
 *
 * 302 で直接 `kichijitsu://` へ飛ばす手もあるが、カスタムスキームへのリダイレクトは
 * ブラウザによって黙って落とされることがあり、そうなると利用者には「何も起きない
 * 真っ白なページ」しか残らない。ここでは (1) 読み込み時に自動でスキームを開き、
 * (2) 失敗しても押せるボタンを置き、(3) 何が起きたかを日本語で説明する、の3点セットにする。
 * 外部ブラウザにはこのページしか残らないので、ここが利用者から見た「完了画面」になる。
 */
export function renderDesktopHandoffPage(deepLink: string): string {
  const safeLink = escapeHtml(deepLink);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>アプリに戻ります - kichijitsu</title>
  </head>
  <body>
    <h1>認証が完了しました</h1>
    <p>kichijitsu デスクトップアプリに戻ります。自動で戻らない場合は下のボタンを押してください。</p>
    <p><a id="back" href="${safeLink}">kichijitsu アプリを開く</a></p>
    <p>このタブは閉じて構いません。</p>
    <script>
      // 読み込み直後に一度だけ自動で開く。ブラウザによってはユーザー操作なしの
      // カスタムスキーム遷移を拒否するため、その場合は上のリンクが受け皿になる。
      window.location.href = document.getElementById("back").href;
    </script>
  </body>
</html>
`;
}

/**
 * チケット交換に失敗したときに webview へ表示するページ。
 * webview にはこの表示しか残らないので、次に何をすればよいかまで書く。
 */
export function renderDesktopExchangeErrorPage(reason: string, appUrl: string): string {
  const safeReason = escapeHtml(reason);
  const safeAppUrl = escapeHtml(appUrl);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ログインを完了できませんでした - kichijitsu</title>
  </head>
  <body>
    <h1>ログインを完了できませんでした</h1>
    <p>${safeReason}</p>
    <p>お手数ですが、アプリの「Google 連携」からもう一度やり直してください。</p>
    <p><a href="${safeAppUrl}">アプリに戻る</a></p>
  </body>
</html>
`;
}

/**
 * 使い捨てチケットを発行して D1 に記録し、アプリへ戻すディープリンクを返す。
 * routes/auth.ts の `/auth/callback` 末尾から呼ばれる。
 *
 * ついでに期限切れの行を掃除する (best-effort)。チケットは寿命が数分なので専用の Cron を
 * 足すほどではなく、発行のたびに古い行を落とせば溜まり続けることはない。
 */
export async function issueDesktopTicket(
  db: D1Database,
  profileId: string,
  challenge: string,
  now: number = Date.now(),
): Promise<string> {
  const ticket = generateDesktopTicket();
  const ticketHash = await hashDesktopSecret(ticket);
  await db.batch([
    db.prepare("DELETE FROM desktop_auth_tickets WHERE expires_at <= ?").bind(now),
    db
      .prepare(
        `INSERT INTO desktop_auth_tickets (ticket_hash, profile_id, challenge, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(ticketHash, profileId, challenge, now + DESKTOP_TICKET_TTL_MS, now),
  ]);
  return buildDesktopDeepLink(ticket);
}

/**
 * add モード用の署名付きトークンを発行する。**有効なセッションが必須** ―― この値は
 * 「このプロファイルへ Google アカウントを足してよい」という許可そのものなので、
 * すでにそのプロファイルとしてログインしている webview からしか取れてはいけない。
 *
 * CSRF: sid は SameSite=Lax なので cross-site の POST には載らない (= 他サイトの
 * fetch/フォームからこのエンドポイントを叩いても 401 になる)。`/auth/logout` と同じ理由で
 * POST 固定にしてあり、偶発的な GET (プリフェッチ・<img src> 等) では発行されない。
 */
desktopAuthRoutes.post("/auth/desktop/add-intent", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE_NAME);
  const profileId = sid ? await verifySessionCookieValue(c.env.SESSION_SECRET, sid) : null;
  if (!profileId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const addToken = await createDesktopAddToken(c.env.SESSION_SECRET, profileId);
  return c.json({ addToken });
});

/**
 * 使い捨てチケットをセッション Cookie に交換する。アプリの webview がここへ
 * **ナビゲート**してくる (ファイル冒頭の流れ図参照)。
 *
 * 検証順は「形式 → 行の取得 → **必ず削除** → 期限 → challenge 照合」。
 * 削除を照合より先に置いているのが肝で、**交換を試みた時点でそのチケットは死ぬ**。
 * こうすると verifier を総当たりしようとしても1回で弾切れになる (単回使用が
 * 「成功したら無効」ではなく「触ったら無効」になる)。
 * DELETE の `meta.changes` が 1 でなければ、同じチケットで別のリクエストが先に
 * 消し込んだということなので、そちらに譲って失敗させる (二重交換の防止)。
 */
desktopAuthRoutes.get("/auth/desktop/exchange", async (c) => {
  const ticket = c.req.query("ticket") ?? "";
  const verifier = c.req.query("verifier") ?? "";
  const fail = (reason: string, status: 400 | 403 | 410) =>
    c.html(renderDesktopExchangeErrorPage(reason, c.env.APP_URL), status);

  if (!isValidDesktopTicketFormat(ticket) || !isValidDesktopHex32(verifier)) {
    return fail("受け取った認証情報の形式が正しくありません。", 400);
  }

  const ticketHash = await hashDesktopSecret(ticket);
  const row = await c.env.DB.prepare(
    "SELECT profile_id, challenge, expires_at FROM desktop_auth_tickets WHERE ticket_hash = ?",
  )
    .bind(ticketHash)
    .first<{ profile_id: string; challenge: string; expires_at: number }>();
  if (!row) {
    return fail("この認証は既に使用済みか、有効期限が切れています。", 400);
  }

  const deleted = await c.env.DB.prepare("DELETE FROM desktop_auth_tickets WHERE ticket_hash = ?")
    .bind(ticketHash)
    .run();
  if (deleted.meta.changes !== 1) {
    return fail("この認証は既に使用済みです。", 400);
  }

  if (!isDesktopTicketFresh(row.expires_at, Date.now())) {
    return fail("認証の有効期限が切れています。", 410);
  }

  const verifierHash = await hashDesktopSecret(verifier);
  if (!timingSafeEqualString(row.challenge, verifierHash)) {
    // このアプリが始めた認証ではないものを掴まされている (悪意あるディープリンクの可能性)。
    // profile_id は一切ログに出さない ―― 誰のものか分からない状態で結び付けないため。
    console.warn("desktop auth exchange: verifier does not match the stored challenge");
    return fail("この認証はこのアプリで開始されたものではありません。", 403);
  }

  const sessionValue = await createSessionCookieValue(c.env.SESSION_SECRET, row.profile_id);
  setCookie(c, SESSION_COOKIE_NAME, sessionValue, {
    httpOnly: true,
    secure: isHttpsRequest(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
  return c.redirect(c.env.APP_URL, 302);
});
