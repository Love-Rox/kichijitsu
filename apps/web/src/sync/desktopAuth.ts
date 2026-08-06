/**
 * Google 連携 (OAuth) の開始口。**ブラウザ版/PWA は従来どおり同一ウィンドウ遷移、
 * デスクトップ版 (Tauri) だけ外部ブラウザ**へ出す (2026-08-07)。
 *
 * # なぜ分けるのか
 * Google は埋め込みブラウザ (embedded user-agent) からの OAuth を禁止しており、
 * デスクトップ版の webview 内で `/auth/login` へ遷移すると **401: disabled_client** で
 * 弾かれる (2026-08-06 に本番で確認)。ブラウザ版は同じクライアント ID・同じ URL で
 * 通るので、変えるべきなのは「どこで開くか」だけ。
 *
 * # 分岐は1箇所だけ
 * 判定は `isTauri()` (sync/githubProvider.ts) ―― `window.__TAURI__` の有無を見るだけで、
 * ブラウザ/PWA では必ず false になる。false のときに実行されるのは
 * `location.href = buildGoogleLoginPath(...)` の1行で、生成される URL 文字列も
 * 従来 (AppToolbar.tsx / AppOverlays.tsx に直書きされていたもの) と**完全に同一**
 * (buildGoogleLoginPath のテストで固定してある)。
 *
 * # デスクトップ版で何が起きるか
 * 1. add モードのときだけ、まず `POST /auth/desktop/add-intent` で短命の署名付き
 *    `add_token` を取る。外部ブラウザには webview の sid cookie が無いため、これが
 *    無いと「アカウント追加のつもりが新規プロファイル作成」になってしまう。
 * 2. Rust の `open_external_login` コマンドへ**相対パス**を渡す。Rust 側が
 *    (a) webview が今読んでいる URL のオリジンに解決し、(b) 自分で作った verifier の
 *    ハッシュ (`dc`) と `desktop=1` を足し、(c) OS の既定ブラウザで開く。
 *    オリジンを web 側で組み立てないのは、公式インスタンスのホスト名を apps/web に
 *    書かないため (セルフホスト時に漏れる) ―― 既存の設定経路 (tauri.conf.json の
 *    ウィンドウ URL) をそのまま使う。
 * 3. 以降は Worker とデスクトップシェルの仕事 (apps/sync/src/routes/desktop-auth.ts
 *    の冒頭コメントに全体の流れ図がある)。
 *
 * fetch も window も引数 (deps) で受け取るので、この層自体はテストでフェイクを渡すだけで
 * 検証できる (sync/logout.ts と同じ流儀)。
 */
import { isTauri } from "./githubProvider";

/** Google 連携をどのモードで始めるか。 */
export type GoogleAuthMode =
  | { kind: "login" }
  /** 既存プロファイルへのアカウント追加 / 再認証。loginHint があれば Google 側で事前選択させる。 */
  | { kind: "add"; loginHint?: string };

/**
 * `/auth/login` に渡すパスを組み立てる**純関数**。
 *
 * ブラウザ経路では `addToken` を渡さないので、生成される文字列は 2026-08-06 まで
 * AppToolbar.tsx / AppOverlays.tsx に直書きされていた3種類と1文字も違わない:
 *   - `/auth/login`
 *   - `/auth/login?add=1`
 *   - `/auth/login?add=1&login_hint=<encodeURIComponent(email)>`
 * (`desktop=1` と `dc` はデスクトップシェル側が足すので、ここには現れない。)
 */
export function buildGoogleLoginPath(mode: GoogleAuthMode, addToken?: string): string {
  if (mode.kind === "login") return "/auth/login";
  let path = "/auth/login?add=1";
  if (mode.loginHint) path += `&login_hint=${encodeURIComponent(mode.loginHint)}`;
  if (addToken) path += `&add_token=${encodeURIComponent(addToken)}`;
  return path;
}

/** startGoogleAuth が触る外の世界。テストではすべてフェイクを渡す。 */
export interface GoogleAuthDeps {
  /** デスクトップ版 (Tauri) かどうか */
  isDesktop: () => boolean;
  /** 同一ウィンドウ遷移 (= 従来のブラウザ挙動) */
  navigate: (path: string) => void;
  /** Rust コマンドの呼び出し (window.__TAURI__.core.invoke) */
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  /** POST /auth/desktop/add-intent で add_token を取る */
  fetchAddToken: () => Promise<string>;
}

/** `window.__TAURI__.core.invoke` の最小型 (githubProvider.ts / desktopNotify.ts と同じ流儀)。 */
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

async function fetchAddTokenFromServer(): Promise<string> {
  // credentials は同一オリジンなので既定 ("same-origin") のままで sid が載る。
  const res = await fetch("/auth/desktop/add-intent", { method: "POST" });
  if (!res.ok) throw new Error(`POST /auth/desktop/add-intent failed: ${res.status}`);
  const body = (await res.json()) as { addToken?: unknown };
  if (typeof body.addToken !== "string" || !body.addToken) {
    throw new Error("POST /auth/desktop/add-intent returned no addToken");
  }
  return body.addToken;
}

function defaultDeps(): GoogleAuthDeps {
  return {
    isDesktop: isTauri,
    navigate: (path) => {
      window.location.href = path;
    },
    invoke: (cmd, args) => {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      if (!tauri) return Promise.reject(new Error("__TAURI__ が無い環境で invoke が呼ばれた"));
      return tauri.core.invoke(cmd, args);
    },
    fetchAddToken: fetchAddTokenFromServer,
  };
}

/**
 * Google 連携を開始する。
 *
 * ブラウザ版/PWA は「パスを組み立てて同一ウィンドウ遷移」だけ (従来と同じ)。
 * デスクトップ版は外部ブラウザへ出す。
 *
 * # 失敗したときに何をするか
 * デスクトップ経路のどこか (add_token の取得、または `open_external_login` の invoke) で
 * 失敗したら、**従来どおりの同一ウィンドウ遷移にフォールバック**する。
 * この経路を持たない古いデスクトップシェル (invoke が reject する) でも、少なくとも
 * 「今までと同じ動き」に落ちるだけで、こちらの変更で新たに壊れる状態は作らない。
 * 黙って何も起きないのが最悪なので、必ず console.warn を残す。
 */
export async function startGoogleAuth(
  mode: GoogleAuthMode,
  deps: GoogleAuthDeps = defaultDeps(),
): Promise<void> {
  if (!deps.isDesktop()) {
    deps.navigate(buildGoogleLoginPath(mode));
    return;
  }

  try {
    const addToken = mode.kind === "add" ? await deps.fetchAddToken() : undefined;
    await deps.invoke("open_external_login", { path: buildGoogleLoginPath(mode, addToken) });
  } catch (err) {
    console.warn(
      "kichijitsu: 外部ブラウザでの Google 連携を開始できませんでした。従来の遷移にフォールバックします",
      err,
    );
    deps.navigate(buildGoogleLoginPath(mode));
  }
}
