//! 自動アップデート(tauri-plugin-updater)。デスクトップ専用。
//!
//! # 何を更新するのか
//! このアプリは本番の Web を読み込む薄いシェルなので、**画面の更新は Web をデプロイすれば
//! 全員に自動で届く**。ここで更新するのはシェル(Rust 側・Info.plist・アイコン等)だけ。
//!
//! # なぜ Rust 側だけで完結させるのか
//! 更新の確認・取得・適用は、webview(リモート URL)から呼べる IPC コマンドにしていない。
//! 呼べるようにすると、リモート側に XSS が刺さったときに「任意のタイミングでアプリを
//! 差し替えさせる」入口が増える(gh_api / notify を1本ずつ絞っているのと同じ脅威モデル)。
//! プラグインの JS 側 API を使わないので、capabilities へ `updater:*` も与えていない。
//!
//! # 流れ
//! - 起動の少し後と、その後 6 時間おきに確認する(トレイ常駐で何日も動き続けるため、
//!   起動時の1回だけでは足りない)。
//! - 新しい版があれば、**ダウンロードとインストールまで**黙って行い、通知で知らせる。
//!   再起動は強制しない(作業中のウィンドウを突然閉じないため)。
//! - トレイの「アップデートを確認」を押すと、インストール済みなら再起動、まだなら
//!   確認して取得し、そのまま再起動する。「最新です」「失敗しました」はダイアログで返す
//!   (通知は OS 側の設定で出ないことがあるため)。経過はログ(updater.log)にも残す。
//! - 署名は `tauri.conf.json` の pubkey で検証される。検証に失敗した更新は適用されない。

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// 起動直後はウィンドウの描画や認証の復帰が重なるので、少し待ってから最初の確認をする。
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// 常駐中の確認間隔。
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// インストール済みだが、まだ再起動していない版を覚えておく。
///
/// これが無いと、バックグラウンドで適用した後にトレイから確認したとき、動いているのは
/// 旧版のままなので「新しい版がある」と判定され、同じ更新を何度も取得してしまう。
#[derive(Default)]
pub struct UpdateState {
    installed_version: Mutex<Option<String>>,
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    // 通知の失敗(権限が無いなど)で更新処理そのものを止めない。
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 手動の確認の結果を、ダイアログで必ず見せる。
///
/// 通知だけだと、OS 側で通知が出ない環境(Windows で通知が無効・未登録など)では、押しても何も
/// 起きないように見える(2026-11-08、v0.1.19 → v0.1.20 の更新で実際に起きた)。
/// ダイアログは OS の通知設定に左右されない。
fn show_result(app: &AppHandle, kind: MessageDialogKind, title: &str, body: &str) {
    app.dialog()
        .message(body)
        .title(title)
        .kind(kind)
        .show(|_| {});
}

/// 更新の経過をログファイル(アプリのログ用フォルダの updater.log)へ1行足す。
///
/// 常駐の確認(6 時間おき)の失敗も、Windows ではコンソールが無く標準エラーが見えないので、
/// ファイルに残さないと原因を追えない。書けなくても更新処理は止めない。
fn log(app: &AppHandle, line: &str) {
    eprintln!("kichijitsu: {line}");
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("updater.log");
    // 肥大化を避けるため、大きくなったら作り直す(直近の経過だけ分かればよい)。
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

/// 更新を確認し、あれば取得して適用する。
///
/// `manual` が true(トレイからの操作)のときだけ、結果を通知で必ず返し、適用後に再起動する。
/// false(バックグラウンド)のときは、更新が無ければ何も言わない。
pub async fn check_and_install(app: &AppHandle, state: &UpdateState, manual: bool) {
    // すでに適用済みなら、手動操作は再起動するだけ。
    let installed = state
        .installed_version
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    if let Some(version) = installed {
        if manual {
            restart(app);
        }
        log(app, &format!("v{version} は適用済みです(再起動待ち)"));
        return;
    }

    log(
        app,
        &format!(
            "更新を確認します(現在 v{}、{})",
            app.package_info().version,
            if manual { "手動" } else { "自動" }
        ),
    );
    let result = try_install(app).await;
    match result {
        Ok(Some(version)) => {
            log(app, &format!("v{version} を適用しました"));
            if let Ok(mut guard) = state.installed_version.lock() {
                *guard = Some(version.clone());
            }
            if manual {
                restart(app);
            } else {
                notify(
                    app,
                    &format!("kichijitsu v{version} をインストールしました"),
                    "トレイのメニュー「アップデートを確認」を押すと、再起動して反映されます。",
                );
            }
        }
        Ok(None) => {
            log(app, "最新の状態です");
            if manual {
                show_result(
                    app,
                    MessageDialogKind::Info,
                    "kichijitsu",
                    &format!("最新の状態です(v{})。", app.package_info().version),
                );
            }
        }
        Err(e) => {
            // 失敗は握りつぶさずログに残す。手動のときは利用者にも伝える。
            log(app, &format!("アップデートに失敗しました: {e}"));
            if manual {
                show_result(app, MessageDialogKind::Error, "アップデートに失敗しました", &e);
            }
        }
    }
}

/// 新しい版があれば取得して適用し、その版番号を返す。無ければ None。
async fn try_install(app: &AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let version = update.version.clone();
    // 進捗は使わない。署名の検証に失敗するとここで Err になり、適用されない。
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(version))
}

/// ウィンドウの位置・大きさを保存してから再起動する。
///
/// 通常の終了経路(トレイの「終了」)と同じく、保存しないと位置が失われる
/// (window-state は破棄時にしか保存しないが、このアプリはウィンドウを破棄しないため)。
fn restart(app: &AppHandle) -> ! {
    let _ = app.save_window_state(StateFlags::all());
    app.restart()
}

/// 起動後と一定間隔の確認を、専用スレッドで回す。
///
/// 専用スレッドにしているのは、スリープ用に tokio を直接の依存へ足さないため
/// (async の確認は tauri の async_runtime へ渡す)。
pub fn spawn_periodic_check(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            let handle = app.clone();
            tauri::async_runtime::block_on(async move {
                let state = handle.state::<UpdateState>();
                check_and_install(&handle, &state, false).await;
            });
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

/// トレイの「アップデートを確認」。クリックを塞がないよう、別タスクで実行する。
pub fn spawn_manual_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<UpdateState>();
        check_and_install(&app, &state, true).await;
    });
}
