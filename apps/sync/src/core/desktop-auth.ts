/**
 * デスクトップ版 (Tauri) を **外部ブラウザ** で OAuth させるための純ロジック (2026-08-07)。
 *
 * # なぜ要るのか
 * Google は「埋め込みブラウザ (embedded user-agent) からの OAuth」を禁止しており、
 * デスクトップ版の webview から `/auth/login` へ同一ウィンドウ遷移すると
 * **401: disabled_client** で弾かれる (2026-08-06 に本番で確認。Google Cloud Console の
 * プロジェクト診断にも「レガシー ブラウザ」警告が出ていた)。ブラウザ版は同じクライアント ID・
 * 同じ URL で通るので、原因は「どの user-agent で開いたか」だけ。
 *
 * # 単に外部ブラウザで開くだけでは解決しない
 * デスクトップ版は本番 URL を webview で読むだけの薄いシェル (docs/desktop.md) で、
 * セッションは **その webview の Cookie**。外部ブラウザで OAuth を完了させると
 * `Set-Cookie` は外部ブラウザ側に付いてしまい、アプリの webview は未ログインのまま。
 * そこで「外部ブラウザで OAuth 完了 → カスタム URL スキーム (`kichijitsu://`) でアプリへ
 * 戻る → アプリが使い捨てチケットを Worker に渡してセッション Cookie を受け取る」
 * という3段の受け渡しにする。
 *
 * # チケットの安全性 (ここが要)
 * 1. **推測不能**: 32 バイトの CSPRNG 値を base64url 化したもの。
 * 2. **単回使用**: サーバーは SHA-256 ハッシュだけを D1 に持ち、交換要求が来たら
 *    (検証の成否に関わらず) 必ずその行を DELETE する。行の存在そのものがチケットの
 *    有効性なので、2回目の交換は必ず「行が無い」で落ちる。
 * 3. **短命**: DESKTOP_TICKET_TTL_MS (下記のコメント参照)。
 * 4. **取り違え防止 (PKCE 相当)**: アプリは OAuth 開始前に verifier (32 バイト乱数の hex) を
 *    自分の中に保持し、外部ブラウザには `SHA-256(verifier)` = challenge しか渡さない。
 *    Worker はチケット行に challenge を焼き込み、交換時に `SHA-256(受け取った verifier)`
 *    と突き合わせる。これにより「攻撃者が自分で取ったチケットを `kichijitsu://` リンクとして
 *    被害者に踏ませ、被害者のアプリを攻撃者のアカウントでログインさせる」(ログイン CSRF /
 *    セッション固定) が成立しない ―― 被害者のアプリは自分が作った verifier しか送らず、
 *    それは攻撃者のチケットの challenge とは一致しないため。
 *    ハッシュを噛ませているのは、外部ブラウザに渡る URL (履歴・ブラウザ同期・拡張機能から
 *    見える) が漏れても、そこから verifier を復元できないようにするため。
 *
 * 「判定・生成・検証」はすべてこのファイルの純関数に閉じ込め、D1 や Hono に触れる配線は
 * routes/desktop-auth.ts 側に置く (test/desktop-auth.test.ts がここを直接テストする)。
 */

/**
 * アプリへ戻るためのカスタム URL スキーム。
 * `apps/desktop/src-tauri/tauri.conf.json` の `plugins.deep-link.desktop.schemes` と
 * **必ず一致させること** (片方だけ変えると OS がアプリへ配送できず、認証が無言で詰まる)。
 */
export const DESKTOP_DEEP_LINK_SCHEME = "kichijitsu";

/**
 * チケットの寿命 (3分)。
 *
 * この値が覆うのは「外部ブラウザで OAuth が終わった瞬間から、OS がアプリへ
 * `kichijitsu://` を配送し、アプリが交換要求を投げるまで」だけ。正常系はコンマ数秒で、
 * 3分は (a) ブラウザが出す「このサイトは kichijitsu を開こうとしています」の確認ダイアログを
 * 利用者が読んで押すまでの間、(b) アプリが終了していて OS がアプリを起動し直す時間、
 * の2つに余裕を持たせた値。ユーザー操作を待つ OAuth 同意画面そのものはこの区間の
 * **手前**にあるので (state cookie の 10分が覆う)、ここを長くする理由は無い ――
 * 短いほど「漏れたチケットが使える窓」も短くなる。
 */
export const DESKTOP_TICKET_TTL_MS = 3 * 60 * 1000;

/**
 * add モード用の署名付きトークンの寿命 (10分)。
 *
 * こちらは `/auth/desktop/add-intent` で発行してから `/auth/login` に到達するまでしか
 * 使われない (= 利用者が「+ アカウントを追加」を押してから外部ブラウザが開くまで) ので
 * 本来は数秒で足りる。state cookie の STATE_MAX_AGE_SECONDS (10分) と同じ値にして、
 * 「OAuth 開始側の猶予はこの長さ」という感覚を1つに揃えている。
 */
export const DESKTOP_ADD_TOKEN_TTL_MS = 10 * 60 * 1000;

/** チケットの生値のバイト数 (mcp-token.ts の RAW_TOKEN_BYTES と同じ 32 バイト = 256bit)。 */
const TICKET_BYTES = 32;

/** base64url (パディング無し) で 32 バイトを表すと必ずこの長さになる。 */
const TICKET_LENGTH = 43;

/** verifier / challenge は 32 バイトを小文字 hex にしたもの (Rust 側と揃える)。 */
const HEX_32_BYTES_LENGTH = 64;

/** add トークンの署名対象に付ける前置き。sid (session.ts) と取り違えられないための領域分離。 */
const ADD_TOKEN_DOMAIN = "kichijitsu-desktop-add";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 使い捨てチケットの生値を作る。副作用なし (D1 への保存は呼び出し側)。
 * 生値はディープリンク経由でアプリにだけ渡り、サーバーは SHA-256 ハッシュしか保存しない
 * (mcp_tokens と同じ方針 ―― 照合できれば十分で、元に戻す必要が無いため)。
 */
export function generateDesktopTicket(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(TICKET_BYTES)));
}

/** D1 やハッシュ計算に触れる前の安価な形式チェック (base64url の 43 文字ちょうど)。 */
export function isValidDesktopTicketFormat(value: string): boolean {
  return value.length === TICKET_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/** verifier / challenge の形式チェック (小文字 hex 64 文字 = 32 バイト)。 */
export function isValidDesktopHex32(value: string): boolean {
  return value.length === HEX_32_BYTES_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** チケット/verifier の SHA-256 を小文字 hex で返す (D1 保存形式・challenge の計算にも使う)。 */
export async function hashDesktopSecret(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToHex(new Uint8Array(digest));
}

/** `expires_at` を過ぎていないか。境界 (now === expiresAt) は期限切れ扱い。 */
export function isDesktopTicketFresh(expiresAt: number, now: number): boolean {
  return now < expiresAt;
}

/** タイミング攻撃を避けるための定数時間比較 (session.ts の timingSafeEqual と同じ実装)。 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** アプリへ戻すディープリンク URL。 */
export function buildDesktopDeepLink(ticket: string): string {
  return `${DESKTOP_DEEP_LINK_SCHEME}://auth?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * `/auth/login` のクエリからデスクトップ経路の challenge を取り出す **純関数**。
 *
 * `desktop=1` と正しい形式の `dc` が **両方** そろっているときだけ challenge を返す。
 * どちらか欠けていれば null = 従来どおりのブラウザ経路 ―― ブラウザ版/PWA はこの2つの
 * クエリを一切付けないので、判定はここで必ず null になり挙動は1ミリも変わらない。
 */
export function parseDesktopLoginChallenge(
  desktopFlag: string | undefined,
  challenge: string | undefined,
): string | null {
  if (desktopFlag !== "1") return null;
  if (!challenge || !isValidDesktopHex32(challenge)) return null;
  return challenge;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * add モード (既存プロファイルへの Google アカウント追加 / 再認証) を **外部ブラウザ** で
 * 始めるための署名付きトークンを作る。形式は `profileId.expiresAt.signature`。
 *
 * # なぜ要るのか
 * 従来の add モードは `/auth/login?add=1` に **sid cookie が付いてくる**ことを前提に
 * プロファイルを決めている。ところが外部ブラウザには sid が無いので、そのままだと
 * 「add のつもりが新規プロファイルを作ってしまう」= アカウントの取り違えになる。
 * そこで webview 側 (= 正規のセッションを持っている側) で一度サーバーに問い合わせ、
 * 「このプロファイルへの追加を、この期限まで許可する」という署名付きの短命な値を
 * 発行してもらい、それを外部ブラウザの URL に載せる。
 *
 * # なぜ sid をそのまま渡さないのか
 * sid は 30 日有効の本物のセッション。URL に載せれば外部ブラウザの履歴に 30 日分の
 * ログイン権が残る。ここで渡すのは「10分だけ有効・このプロファイルへの add だけができる」
 * 専用の値に限定する。
 *
 * # なぜ署名対象に前置き (ADD_TOKEN_DOMAIN) を付けるのか
 * 署名鍵 (SESSION_SECRET) は sid と共通なので、`profileId.expiresAt` をそのまま署名すると
 * **生成物が sid としてもそのまま通ってしまう** (session.ts と同じ形式・同じ鍵)。
 * 署名対象にドメイン文字列を混ぜることで、両者は決して交換できなくなる。
 */
export async function createDesktopAddToken(
  secret: string,
  profileId: string,
  now: number = Date.now(),
): Promise<string> {
  const expiresAt = now + DESKTOP_ADD_TOKEN_TTL_MS;
  const signature = await sign(secret, `${ADD_TOKEN_DOMAIN}.${profileId}.${expiresAt}`);
  return `${profileId}.${expiresAt}.${signature}`;
}

/** 署名が正しく期限内なら profileId を返す。改ざん・期限切れ・形式不正はすべて null。 */
export async function verifyDesktopAddToken(
  secret: string,
  value: string,
  now: number = Date.now(),
): Promise<string | null> {
  // profileId 自体にドットが入っていても壊れないよう右から2つ切り出す (session.ts と同じ作法)。
  const lastDot = value.lastIndexOf(".");
  if (lastDot === -1) return null;
  const signature = value.slice(lastDot + 1);
  const rest = value.slice(0, lastDot);
  const secondDot = rest.lastIndexOf(".");
  if (secondDot === -1) return null;
  const expiresAtStr = rest.slice(secondDot + 1);
  const profileId = rest.slice(0, secondDot);
  if (!profileId || !expiresAtStr || !signature) return null;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isInteger(expiresAt)) return null;

  const expected = await sign(secret, `${ADD_TOKEN_DOMAIN}.${profileId}.${expiresAtStr}`);
  if (!timingSafeEqualString(expected, signature)) return null;
  if (expiresAt <= now) return null;

  return profileId;
}
