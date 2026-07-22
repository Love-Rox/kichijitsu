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
// - アプリ内リロード: リモート URL 方式（上記）のため web 側を再デプロイしても
//   webview は起動時のページを保持し続け、手動リロード手段が無いと最新化されない。
//   トレイの「再読み込み」メニューと、グローバルショートカット CmdOrCtrl+R
//   （誤爆防止のフォーカス/表示ガード付き）の2経路でメインウィンドウの
//   webview に `location.reload()` を評価させる（下記 reload_main_window 参照）。
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
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// `gh api` に渡してよい `endpoint` かどうかを判定するホワイトリスト。
///
/// # 脅威モデル
/// このデスクトップアプリの webview はローカルファイルではなく**リモート URL**
/// (`https://kichijitsu.love-rox.cc`) を読む(ファイル先頭コメント・docs/desktop.md
/// 参照)。そのサイトに何らかの XSS が刺さると、`window.__TAURI__` 経由で
/// `invoke('gh_api', { endpoint })` を任意の `endpoint` で呼べてしまい、手元の
/// `gh` CLI 認証を使って任意の GitHub REST エンドポイントを叩けてしまう
/// (認証情報の持ち出し・書き込み系エンドポイントの悪用など)。`gh api` は
/// デフォルトが GET なのでこのコマンド単体に書き込みの実害は薄いが、
/// 「web 側が今使っている形だけを許可し、それ以外は理由を問わず拒否する」
/// 設計にすることで、攻撃対象領域をアプリが実際に必要とする範囲に絞る。
///
/// # 判定内容
/// `endpoint` は `gh api` の唯一の位置引数で、`<path>` または `<path>?<query>`
/// の形。まず制御文字(`\r`/`\n` 等 0x20 未満)混入と先頭 `-`(clap のオプション
/// パーサに引数として解釈させる flag-injection)を弾き、その後 `path` を
/// `apps/web/src/sync/githubProvider.ts` 等が実際に使っている9形状とだけ
/// 突き合わせる(完全一致・余分なセグメント不可)。`owner`/`repo` は
/// `[A-Za-z0-9._-]`、`number` は数字のみに制限する。
fn is_allowed_gh_endpoint(endpoint: &str) -> bool {
    // 制御文字混入は先頭で拒否(ヘッダ/行インジェクション対策)。
    if endpoint.chars().any(|c| c.is_ascii_control()) {
        return false;
    }
    // 先頭 `-` は `gh` の引数パーサにオプションとして解釈されうるため拒否
    // (例: `--hostname=evil.example.com`)。
    if endpoint.starts_with('-') {
        return false;
    }

    let (path, query) = match endpoint.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (endpoint, None),
    };

    fn is_valid_owner_or_repo(s: &str) -> bool {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }

    fn is_valid_number(s: &str) -> bool {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
    }

    let segments: Vec<&str> = path.split('/').collect();
    match segments.as_slice() {
        // 1. search/issues (work queue 検索。q= で始まるクエリのみ許可)
        ["search", "issues"] => match query {
            Some(q) => q.starts_with("q="),
            None => true,
        },
        // 2. user/repos (リポジトリ列挙)
        ["user", "repos"] => true,
        // 3. user (認証ユーザーのログイン名解決、クエリなし)
        ["user"] => query.is_none(),
        // 4-8. repos/{owner}/{repo}/<固定パス> (クエリ任意)
        ["repos", owner, repo, "milestones"]
        | ["repos", owner, repo, "issues"]
        | ["repos", owner, repo, "releases"]
        | ["repos", owner, repo, "commits"]
            if is_valid_owner_or_repo(owner) && is_valid_owner_or_repo(repo) =>
        {
            true
        }
        ["repos", owner, repo, "actions", "runs"]
            if is_valid_owner_or_repo(owner) && is_valid_owner_or_repo(repo) =>
        {
            true
        }
        // 9. repos/{owner}/{repo}/pulls/{number}/commits (クエリ任意)
        ["repos", owner, repo, "pulls", number, "commits"]
            if is_valid_owner_or_repo(owner)
                && is_valid_owner_or_repo(repo)
                && is_valid_number(number) =>
        {
            true
        }
        _ => false,
    }
}

/// GUI アプリ(Dock/Finder 起動)は最小 PATH しか持たず、Homebrew 等の bin ディレクトリを
/// 含まない。そこで `gh` の実体を、よくあるインストール先を順に見て解決する。見つからなければ
/// `"gh"`(PATH 頼み)にフォールバックする。
///
/// macOS の GUI プロセスの PATH は通常 `/usr/bin:/bin:/usr/sbin:/sbin` だけで、
/// Homebrew(Apple Silicon の `/opt/homebrew/bin`、Intel の `/usr/local/bin`)が入らない。
/// ターミナルでは `gh` が動くのにデスクトップアプリからは「gh 不在」で失敗する典型原因。
/// 候補パスは他 OS では単に存在せず、最後の `"gh"` フォールバックに落ちるだけなので無害。
fn resolve_gh_path() -> std::path::PathBuf {
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/gh", // macOS (Apple Silicon) Homebrew
        "/usr/local/bin/gh",    // macOS (Intel) Homebrew / 一般的な /usr/local
        "/usr/bin/gh",          // Linux 等のパッケージ
    ];
    for c in CANDIDATES {
        let p = std::path::Path::new(c);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let p = std::path::Path::new(&home).join(".local/bin/gh");
        if p.exists() {
            return p;
        }
    }
    std::path::PathBuf::from("gh")
}

/// 子プロセス(gh、および gh が内部で呼ぶ git 等)向けに、Homebrew 等の bin を先頭に補った
/// PATH を作る。GUI 起動時の痩せた PATH でも gh とその依存が見つかるようにする。
fn augmented_path() -> String {
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    match std::env::var("PATH") {
        Ok(existing) if !existing.is_empty() => format!("{extra}:{existing}"),
        _ => extra.to_string(),
    }
}

/// `gh api <endpoint>` を実行し stdout(GitHub REST の生 JSON 文字列)を返す。
///
/// - **非シェル実行**: `std::process::Command::new(<gh の実体パス>).arg("api").arg(endpoint)` で
///   直接プロセスを起動する。シェル(`sh -c`)を介さないため、`endpoint` に何が来ても
///   シェルインジェクションは起きない。呼べるのは常に `gh api <一引数>` だけで、
///   任意コマンド実行はできない(`endpoint` は search クエリ等の API パスのみを想定)。
/// - **PATH 解決**: GUI アプリの痩せた PATH では bare `"gh"` の spawn が「不在」で失敗するため、
///   `resolve_gh_path()` で実体を解決し、`augmented_path()` で子プロセスの PATH も補う
///   (macOS の Dock 起動で Homebrew の gh が見つからない問題への対処)。
/// - **ホワイトリスト**: プロセス起動前に `is_allowed_gh_endpoint` で `endpoint` の
///   形状を検査する。web 側がリモート URL 経由で XSS を受けても、任意の GitHub
///   API を叩けないようにするための境界(ファイル先頭コメント・
///   `is_allowed_gh_endpoint` のドキュメントコメント参照)。
/// - `gh` 不在は spawn 失敗として、未ログイン等の API エラーは非0終了の stderr として
///   分かるエラーメッセージにして Err で返す(web 側はフォールバックできる)。
///
/// 注: これはアプリ自前の command なので、Tauri v2 では capability(ACL)の追加許可は
/// 不要(プラグイン command と違い application command は invoke 可能)。
#[tauri::command]
async fn gh_api(endpoint: String) -> Result<String, String> {
    if !is_allowed_gh_endpoint(&endpoint) {
        return Err(format!(
            "gh api endpoint がホワイトリスト外のため拒否しました: {endpoint}"
        ));
    }

    let output = std::process::Command::new(resolve_gh_path())
        .arg("api")
        .arg(&endpoint)
        .env("PATH", augmented_path())
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

/// メインウィンドウの webview をリロードするグローバルショートカット。
///
/// `CmdOrCtrl+R` はブラウザやエディタなど他アプリでも頻用される一般的な
/// 組み合わせなので、グローバル登録すると kichijitsu が前面にいないときの
/// 押下まで拾ってしまう(誤爆)。そのためハンドラ側では
/// `reload_main_window_if_focused` を通し、ウィンドウがフォーカス中または
/// 表示中のときだけ実際にリロードする(setup() 内の登録箇所を参照)。
#[cfg(desktop)]
const RELOAD_SHORTCUT: &str = "CmdOrCtrl+R";

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

/// メインウィンドウの webview をリロードする際に評価する JS。
///
/// 単純な `location.reload()` だけでは不十分だった: このアプリの web 側
/// (`public/sw.js`)は Service Worker を持ち、CSS/JS 資産を cache-first で
/// 返す。そのため `location.reload()` で HTML は最新化されても、資産は
/// Service Worker の Cache Storage に載ったままの古いものが返り続け、
/// 実際に更新が反映されない問題が起きた。
///
/// この IIFE は `caches`(Cache Storage API)が使える場合に `kichijitsu-`
/// プレフィックスのキャッシュだけを全削除してから `location.reload()` する。
/// Service Worker 自体は unregister しない(オフライン継続のため、SW の
/// 存在は保ったまま中身のキャッシュだけ破棄する)。`kichijitsu-` 以外の
/// プレフィックスのキャッシュ(将来 SW が増えた場合など)には触れない。
/// `caches` 不在や削除失敗は無視して(best-effort)必ず `location.reload()`
/// まで到達させる。
const RELOAD_JS: &str = r#"(async () => { try { if (self.caches) { const ks = await caches.keys(); await Promise.all(ks.filter(k => k.startsWith('kichijitsu-')).map(k => caches.delete(k))); } } catch (e) {} location.reload(); })()"#;

/// メインウィンドウの webview をリロードする。
///
/// このアプリはリモート URL 方式(ファイル先頭コメント参照)で、webview は
/// 起動時に読み込んだページを保持し続ける。web 側を再デプロイしても自動では
/// 反映されないため、`RELOAD_JS`(キャッシュ破棄付きハードリロード。コメント
/// 参照)を評価させて最新の HTML とそれが指す最新ハッシュ付きアセットを
/// 取得し直させる。ウィンドウが見つからない場合は何もしない(best-effort。
/// トレイメニュー/グローバルショートカットのどちらから呼ばれても失敗時に
/// パニックさせたくない)。
fn reload_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.eval(RELOAD_JS);
}

/// ウィンドウがフォーカス中または表示中のときだけ `reload_main_window` を呼ぶ。
///
/// `CmdOrCtrl+R` グローバルショートカットのハンドラ専用のガード。トレイの
/// 「再読み込み」メニュー(ユーザーが明示的にクリックした操作)はこのガードを
/// 経由せず常にリロードしてよいため呼ばない(RELOAD_SHORTCUT のコメント参照)。
#[cfg(desktop)]
fn reload_main_window_if_focused(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let is_focused = window.is_focused().unwrap_or(false);
    let is_visible = window.is_visible().unwrap_or(false);
    if is_focused || is_visible {
        reload_main_window(app);
    }
}

/// デスクトップアプリのバージョン (`Cargo.toml` の `package.version`) を返す。
///
/// ビルド番号表示 (ユーザー要望、2026-07-22): このアプリはリモート URL 方式
/// (ファイル先頭コメント参照) のため、webview がキャッシュ由来の古いビルドを表示し続けても
/// web 側だけでは気づけない。設定モーダル (apps/web/src/components/SettingsModal.tsx) が
/// この値を「アプリ v{version}」として web 側のビルド SHA/時刻と並べて表示することで、
/// 少なくともネイティブシェルのバージョンだけは確認できるようにする。
///
/// `env!("CARGO_PKG_VERSION")` はコンパイル時に `Cargo.toml` の `[package] version` を
/// 埋め込むマクロ ―― 実行時のファイル I/O や外部コマンド起動は無い。
///
/// 注: アプリ自前の command はローカルコンテンツからなら capability(ACL)無しで invoke
/// できるが、このアプリの webview はリモート URL を読む (ファイル先頭コメント参照) ため、
/// `gh_api` 同様 capabilities/remote.json 側で `allow-app-version` を明示許可しないと
/// リモートコンテンツからの invoke は全拒否される。
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // ウィンドウサイズ/位置の永続化。tauri.conf.json の windows[0]
        // width/height (1200x800) は保存済み状態が無い初回起動時のみの
        // デフォルトで、このプラグインが起動時に自動でウィンドウへ適用する
        // (保存済み状態があれば以降はそちらが優先される)。保存タイミングは
        // 既定でウィンドウ破棄(destroy)時だが、このアプリは「閉じる」で
        // ウィンドウを破棄せず隠すだけなので、明示的な save_window_state
        // 呼び出しが別途必要(on_window_event の CloseRequested 分岐と
        // on_menu_event の "quit" 分岐のコメント参照)。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![gh_api, app_version])
        .setup(|app| {
            // --- トレイ常駐 ---
            let toggle_i = MenuItem::with_id(app, "toggle", "表示/隠す", true, None::<&str>)?;
            let reload_i = MenuItem::with_id(app, "reload", "再読み込み", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &reload_i, &quit_i])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                // メニューは右クリックのみで開く。左クリックは表示/隠すトグル専用
                // にするため、メニューの自動表示はオフにする
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_main_window(app),
                    "reload" => reload_main_window(app),
                    // アプリの唯一の真の終了経路。tauri-plugin-window-state は
                    // 既定でウィンドウ破棄時にしか状態を保存しないが、この
                    // アプリは「閉じる」でウィンドウを破棄しない(下記
                    // on_window_event 参照)ため、破棄イベントが一度も
                    // 発生しないまま app.exit(0) でプロセスごと終了しうる。
                    // 終了直前に明示 save しないとウィンドウ位置/サイズが
                    // 一切永続化されないため、exit の前に必ず保存する。
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::all());
                        app.exit(0);
                    }
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

                // ショートカットごとに `on_shortcut` で個別ハンドラを登録する。
                // ビルダー側の `with_handler`(旧実装)は登録済みの全ショートカット
                // に対して一律に発火するため、トグルとリロードのように挙動が
                // 異なる複数のショートカットを扱うには使えない
                // (両方のキー入力で同じハンドラが呼ばれてしまう)。
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

                app.global_shortcut()
                    .on_shortcut(TOGGLE_WINDOW_SHORTCUT, |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            toggle_main_window(app);
                        }
                    })?;

                // CmdOrCtrl+R (RELOAD_SHORTCUT のコメント参照): 誤爆防止のため
                // フォーカス/表示ガード付きの reload_main_window_if_focused を通す。
                app.global_shortcut()
                    .on_shortcut(RELOAD_SHORTCUT, |app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            reload_main_window_if_focused(app);
                        }
                    })?;
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
                // tauri-plugin-window-state はウィンドウ破棄(destroy)時に
                // 保存するのが既定動作だが、ここでは破棄せず隠すだけなので
                // 破棄時保存は発火しない。「閉じる」のたびにここで明示保存
                // しておくことで、真の終了("quit" メニュー、上記
                // on_menu_event 参照)を待たずとも、閉じた時点のサイズ/位置
                // が失われない(例: 閉じた直後に OS ごと再起動された場合など)。
                let _ = window.app_handle().save_window_state(StateFlags::all());
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- 1. 許可される9形状(web 側の実使用例に寄せる) ---

    #[test]
    fn allows_search_issues_with_q_query() {
        // apps/web/src/sync/githubProvider.ts の WORK_QUEUE_ENDPOINTS そのまま。
        assert!(is_allowed_gh_endpoint(
            "search/issues?q=is:open is:pr review-requested:@me&per_page=50"
        ));
        assert!(is_allowed_gh_endpoint(
            "search/issues?q=is:open is:issue assignee:@me&per_page=50"
        ));
        assert!(is_allowed_gh_endpoint(
            "search/issues?q=is:open is:pr author:@me&per_page=50"
        ));
        assert!(is_allowed_gh_endpoint("search/issues"));
    }

    #[test]
    fn allows_user_repos() {
        assert!(is_allowed_gh_endpoint("user/repos"));
        assert!(is_allowed_gh_endpoint("user/repos?per_page=100"));
    }

    #[test]
    fn allows_user_without_query() {
        assert!(is_allowed_gh_endpoint("user"));
    }

    #[test]
    fn allows_repos_owner_repo_milestones() {
        assert!(is_allowed_gh_endpoint("repos/Love-Rox/kichijitsu/milestones"));
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/milestones?state=open"
        ));
    }

    #[test]
    fn allows_repos_owner_repo_issues() {
        assert!(is_allowed_gh_endpoint("repos/Love-Rox/kichijitsu/issues"));
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/issues?state=all&per_page=50"
        ));
    }

    #[test]
    fn allows_repos_owner_repo_releases() {
        assert!(is_allowed_gh_endpoint("repos/Love-Rox/kichijitsu/releases"));
    }

    #[test]
    fn allows_repos_owner_repo_commits() {
        assert!(is_allowed_gh_endpoint("repos/Love-Rox/kichijitsu/commits"));
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/commits?author=sasagar"
        ));
    }

    #[test]
    fn allows_repos_owner_repo_actions_runs() {
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/actions/runs"
        ));
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/actions/runs?per_page=10"
        ));
    }

    #[test]
    fn allows_repos_owner_repo_pulls_number_commits() {
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/pulls/42/commits"
        ));
        assert!(is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/pulls/42/commits?per_page=100"
        ));
    }

    // --- 2. owner/repo に不正文字 ---

    #[test]
    fn rejects_owner_or_repo_with_invalid_chars() {
        // スペースは [A-Za-z0-9._-] の範囲外。
        assert!(!is_allowed_gh_endpoint("repos/owner/re po/issues"));
        // owner/repo に `/` が入る(=セグメント数が増える)形は9形状に合致しない。
        assert!(!is_allowed_gh_endpoint("repos/own/er/repo/issues"));
        // `%` は [A-Za-z0-9._-] の範囲外。
        assert!(!is_allowed_gh_endpoint("repos/owner/repo..%2f/issues"));
    }

    // --- 3. number に非数字 ---

    #[test]
    fn rejects_non_digit_pull_number() {
        assert!(!is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/pulls/abc/commits"
        ));
        assert!(!is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/pulls/42a/commits"
        ));
        assert!(!is_allowed_gh_endpoint(
            "repos/Love-Rox/kichijitsu/pulls//commits"
        ));
    }

    // --- 4. 先頭 `-` (flag injection) ---

    #[test]
    fn rejects_endpoint_starting_with_dash() {
        assert!(!is_allowed_gh_endpoint("-Hfoo"));
        assert!(!is_allowed_gh_endpoint("--jq=.token"));
        assert!(!is_allowed_gh_endpoint("--hostname=evil.example.com"));
    }

    // --- 5. 制御文字混入 ---

    #[test]
    fn rejects_endpoint_with_control_characters() {
        assert!(!is_allowed_gh_endpoint("search/issues?q=foo\r\nX-Evil: 1"));
        assert!(!is_allowed_gh_endpoint("user/repos\n"));
        assert!(!is_allowed_gh_endpoint("repos/Love-Rox/kichijitsu/issues\r"));
    }

    // --- 6. 9形状の外 ---

    #[test]
    fn rejects_endpoints_outside_the_nine_shapes() {
        assert!(!is_allowed_gh_endpoint(
            "repos/owner/repo/contents/secret"
        ));
        assert!(!is_allowed_gh_endpoint("user/keys"));
        assert!(!is_allowed_gh_endpoint("orgs/acme/members"));
        assert!(!is_allowed_gh_endpoint("graphql"));
        // 単一 issue 取得は9形状に含まれない(issues 一覧のみ許可)。
        assert!(!is_allowed_gh_endpoint("repos/owner/repo/issues/5"));
        assert!(!is_allowed_gh_endpoint(""));
    }

    // --- 7. search/issues のクエリが q= で始まらない ---

    #[test]
    fn rejects_search_issues_query_not_starting_with_q() {
        assert!(!is_allowed_gh_endpoint("search/issues?sort=updated"));
        assert!(!is_allowed_gh_endpoint(
            "search/issues?per_page=50&q=is:open"
        ));
    }
}
