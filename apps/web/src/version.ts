/**
 * ビルド番号表示 (ユーザー要望、2026-07-22)。リモート URL 方式のデスクトップアプリ
 * (docs/desktop.md) は webview がキャッシュ済みの古いビルドを表示し続けることがあり、
 * 「いま見ているビルドがどれか」を確認する手段が無かった。設定モーダル (SettingsModal.tsx)
 * のフッターに表示するための値/整形関数をここに集約する。
 *
 * `__BUILD_SHA__`/`__BUILD_TIME__` は vite.config.ts の `define` でビルド時に静的な
 * 文字列リテラルへ置換される (JSON.stringify 済み。値はグローバル定数)。`vp dev` の
 * 通常起動では `define` は評価されるが、テストランナーや将来的な設定変更で未定義になる
 * 場合に備え、`typeof` ガードで "dev" にフォールバックする。
 */
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA = typeof __BUILD_SHA__ !== "undefined" ? __BUILD_SHA__ : "dev";
export const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "";

/**
 * ISO 形式のビルド時刻を表示用に `YYYY-MM-DD HH:mm` (ローカルタイム) へ整形する純関数。
 * 不正な入力 (パースできない文字列・空文字) はそのまま元の文字列を返す
 * ―― 表示欄が空白になるより、生の値が出ている方が「何かおかしい」と気づきやすい。
 */
export function formatBuildTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * `window.__TAURI__.core.invoke` の最小型 (公式の型パッケージを入れず局所宣言に留める)。
 * githubProvider.ts の TauriGlobal/tauriInvoke と同じ流儀 ―― 型はそちらとは独立に持つ
 * (このファイルだけを import しても sync/githubProvider.ts に依存しなくてよいように)。
 */
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

/**
 * デスクトップアプリ (Tauri) のバージョンを取得する。Rust 側の `app_version` コマンド
 * (apps/desktop/src-tauri/src/lib.rs、`env!("CARGO_PKG_VERSION")` を返す) を invoke する。
 * ブラウザ/PWA (`window.__TAURI__` 無し) や、invoke 自体が失敗した場合 (未対応バージョンの
 * デスクトップアプリ・ACL 未設定など) は null を返す best-effort 実装 ――
 * 設定モーダル側はこれを「デスクトップ情報なし」として扱い、web のビルド情報だけ出す。
 */
export async function getDesktopVersion(): Promise<string | null> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) return null;

  try {
    const version = await tauri.core.invoke("app_version");
    return typeof version === "string" ? version : null;
  } catch (err) {
    console.warn("kichijitsu: app_version invoke failed", err);
    return null;
  }
}
