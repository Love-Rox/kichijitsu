/**
 * デスクトップ版 (Tauri) のネイティブ通知を出すだけの薄い橋渡し。
 *
 * 判定は sync/reminderSchedule.ts の純関数が済ませてあり、ここは
 * 「この文言で通知を出せ」と Rust 側の `notify` コマンドに渡すだけ。
 *
 * ブラウザ/PWA では何もしない (false を返す)。Web Notification API に落とす選択肢も
 * あるが、ブラウザではタブを閉じれば止まる・許可 UI が別物と、挙動と説明が二重になる。
 * 今回はデスクトップ版だけを対象と決め、ドキュメントにもそう書いている。
 */

/**
 * `window.__TAURI__.core.invoke` の最小型 (公式の型パッケージを入れず局所宣言に留める)。
 * githubProvider.ts / version.ts と同じ流儀 ―― 型はそれらとは独立に持つ
 * (このファイルだけを import しても他モジュールに依存しなくてよいように)。
 */
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauriGlobal(): TauriGlobal | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
}

/** デスクトップ版で通知を出せる環境かどうか */
export function canNotifyNatively(): boolean {
  return tauriGlobal() !== undefined;
}

/**
 * ネイティブ通知を1件出す。出せた(=Rust 側の invoke が成功した)かどうかを返す。
 *
 * 注意: `true` は「OS に依頼が通った」までしか意味しない。**実際に通知が画面に出たかは
 * 分からない** ―― tauri-plugin-notification の desktop 実装は `show()` を別タスクへ
 * spawn して結果を捨てており (2.3.3 src/desktop.rs)、macOS で通知が拒否されていても
 * エラーは返ってこない。したがって「許可されているか」をプログラムから判定する術は
 * 無く、設定画面の「テスト通知を送る」で利用者自身に確かめてもらう方針にしている
 * (components/SettingsModal.tsx の ReminderControl)。
 */
export async function notifyNatively(title: string, body: string): Promise<boolean> {
  const tauri = tauriGlobal();
  if (!tauri) return false;
  try {
    await tauri.core.invoke("notify", { title, body });
    return true;
  } catch (err) {
    console.warn("kichijitsu: notify invoke failed", err);
    return false;
  }
}
