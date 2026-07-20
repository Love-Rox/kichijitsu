// kichijitsu デスクトップシェル。
//
// フロントエンドは同梱しない。webview は tauri.conf.json の
// app.windows[].url が指す本番サイト (https://kichijitsu.love-rox.cc) を
// そのまま読む薄いガワ（増分1、docs/desktop.md 参照）。
//
// 増分2a: その上に OS ネイティブなシェル機能を Rust 側だけで足す
// （リモート URL 方式でフロントを同梱していないため、フロントから
// 制御できない。トレイ/ショートカット/通知はすべて Rust の setup() で
// 完結させる）。
// - トレイ常駐: 「表示/隠す」「終了」メニュー + 左クリックでウィンドウ
//   表示/フォーカスをトグル。ウィンドウの「閉じる」はアプリを終了させず
//   トレイに格納する
// - グローバルショートカット: トレイ左クリックと同じトグル動作を
//   ショートカットキーからも呼べるようにする
// - ネイティブ通知: プラグインを配線し、起動時に1回テスト通知を出す
//   ところまで（実際のリマインダー通知はフロントから Tauri コマンドを
//   呼ぶ配線が要るため次増分 TODO。下記 setup() 内コメント参照）
//
// 増分2b: gh プロバイダ（薄い実証＝作業キューのみ）。認証が取りづらい org でも、
// 手元の `gh` CLI 認証で GitHub データを取れるようにする
// （docs/github-integration.md「認証プロバイダの抽象化」）。リモート URL の web は
// Tauri の JS API に直接触れないため、tauri.conf.json の app.withGlobalTauri=true で
// webview に window.__TAURI__ を注入し、web 側は invoke('gh_api', …) を呼ぶ。
// 実リマインダーのフロント連携・Homebrew 配布・他 GitHub データ(items/activity/ci/
// pr-commits)の gh 化は別増分（docs/desktop.md「次の増分」参照）。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// `gh api <endpoint>` を実行し stdout(GitHub REST の生 JSON 文字列)を返す。
///
/// - **非シェル実行**: `std::process::Command::new("gh").arg("api").arg(endpoint)` で
///   直接プロセスを起動する。シェル(`sh -c`)を介さないため、`endpoint` に何が来ても
///   シェルインジェクションは起きない。呼べるのは常に `gh api <一引数>` だけで、
///   任意コマンド実行はできない(`endpoint` は search クエリ等の API パスのみを想定)。
/// - `gh` 不在は spawn 失敗として、未ログイン等の API エラーは非0終了の stderr として
///   分かるエラーメッセージにして Err で返す(web 側はフォールバックできる)。
///
/// 注: これはアプリ自前の command なので、Tauri v2 では capability(ACL)の追加許可は
/// 不要(プラグイン command と違い application command は invoke 可能)。
#[tauri::command]
async fn gh_api(endpoint: String) -> Result<String, String> {
    let output = std::process::Command::new("gh")
        .arg("api")
        .arg(&endpoint)
        .output()
        .map_err(|e| {
            format!("gh の起動に失敗しました({e})。gh CLI が未インストールの可能性があります")
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        return Err(if msg.is_empty() {
            format!("gh api が失敗しました (exit {:?})", output.status.code())
        } else {
            format!("gh api が失敗しました: {msg}")
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// ウィンドウの表示/フォーカスをトグルするグローバルショートカット。
/// トレイアイコンの左クリックと同じ `toggle_main_window` を呼ぶ。
/// macOS/Windows/Linux 共通の "CmdOrCtrl" 記法（`tauri-plugin-global-shortcut`
/// の文字列パーサ）を使い、OS ごとに定義を分けなくてよいようにしている。
#[cfg(desktop)]
const TOGGLE_WINDOW_SHORTCUT: &str = "CmdOrCtrl+Shift+K";

/// メインウィンドウの表示状態をトグルする。
///
/// 隠れている（または最小化されている）場合は表示して前面に出し、
/// 表示中なら隠す。トレイの左クリックとグローバルショートカットの
/// 両方から呼ばれる共通処理。
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_visible = window.is_visible().unwrap_or(false);
    if is_visible {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![gh_api])
        .setup(|app| {
            // --- トレイ常駐 ---
            let toggle_i = MenuItem::with_id(app, "toggle", "表示/隠す", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                // メニューは右クリックのみで開く。左クリックは表示/隠すトグル専用
                // にするため、メニューの自動表示はオフにする
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // --- グローバルショートカット ---
            // モバイルには存在しないプラグインなので #[cfg(desktop)] で囲む
            // （Cargo.toml 側でも target cfg で依存自体をデスクトップ限定に
            // している）。
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                toggle_main_window(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(TOGGLE_WINDOW_SHORTCUT)?;
            }

            // --- ネイティブ通知: 配線の土台のみ ---
            // 実際のリマインダー通知（予定の通知）はフロント(リモート URL の
            // web アプリ)から Tauri コマンドを呼ぶ配線が要る。今回はフロント
            // 連携を含まないため、プラグインが動く土台として起動時に1回だけ
            // テスト通知を出す。
            // TODO(次増分): フロントから呼べる通知コマンド
            // （例: #[tauri::command] fn notify(title, body)）を追加し、
            // Web Push (VAPID) 相当のリマインダーをネイティブ通知に配線する
            // (docs/multiplatform.md「通知」セクション参照)。
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = app
                    .notification()
                    .builder()
                    .title("kichijitsu")
                    .body("トレイ常駐・グローバルショートカット・通知の土台が起動しました")
                    .show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // ウィンドウの「閉じる」でアプリを終了させず、トレイに残す。
            // アプリの終了はトレイメニューの「終了」(app.exit(0)) からのみ。
            // macOS でも Dock から閉じるボタンを押した際に同じ挙動になる
            // （デスクトップ全体で同一の常駐アプリとして振る舞わせる方針）。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
