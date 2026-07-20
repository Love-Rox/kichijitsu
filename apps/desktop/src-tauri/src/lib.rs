// kichijitsu デスクトップシェル（増分1: リモート URL 方式）。
//
// フロントエンドは同梱しない。webview は tauri.conf.json の
// app.windows[].url が指す本番サイト (https://kichijitsu.love-rox.cc) を
// そのまま読む薄いガワなので、Tauri コマンド (invoke ハンドラ) は無い。
// トレイ常駐・グローバルショートカット・ネイティブ通知・gh プロバイダは
// 次増分で追加する (docs/desktop.md 参照)。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
