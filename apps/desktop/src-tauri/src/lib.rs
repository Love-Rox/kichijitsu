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
// - ネイティブ通知: `#[tauri::command] fn notify(title, body)` として web 側へ
//   公開する（capabilities/remote.json の allow-notify）。「いつ・どの予定を
//   通知するか」の判定はリモート URL 側の web が持つ（予定データが web の
//   IndexedDB にしか無いため）。Rust は渡された文言を OS に流すだけ。
//   apps/web/src/sync/reminderSchedule.ts / hooks/useEventReminders.ts 参照
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
// Homebrew 配布・他 GitHub データ(items/activity/ci/pr-commits)の gh 化は別増分
// （docs/desktop.md「次の増分」参照）。

// 増分2d: Google 連携を **外部ブラウザ** で行う（2026-08-07）。
// Google は埋め込みブラウザ(embedded user-agent)からの OAuth を禁止しており、この
// webview の中で /auth/login へ遷移すると 401: disabled_client で弾かれる
// （2026-08-06 に本番で確認。Console のプロジェクト診断にも「レガシー ブラウザ」警告）。
// そこで OAuth 自体は OS の既定ブラウザで完了させ、カスタム URL スキーム
// `kichijitsu://` でこのアプリへ戻り、使い捨てチケットを webview のセッション Cookie に
// 交換する。全体の流れと安全性の設計は apps/sync/src/routes/desktop-auth.ts と
// apps/sync/src/core/desktop-auth.ts の冒頭コメントにまとめてある。
// Rust 側の担当は「verifier を持つ」「外部ブラウザを開く」「戻ってきた ticket と
// verifier を webview に踏ませる」の3つだけ（下記 open_external_login /
// handle_auth_deep_link）。

use std::sync::Mutex;

use sha2::{Digest, Sha256};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Url, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
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

/// gh パス上書きの **形だけ** を見る純関数(ファイルシステムには触れない)。
///
/// # なぜ純関数として切り出したか (2026-07-30)
/// 元々この規則は `select_gh_binary` の中に直書きされ、`gh_api` の**実行時**にしか
/// 適用されていなかった。そのため設定画面で誤ったパスを保存しても保存自体は成功し、
/// 後になって「GitHub の予定・実績が取れない」という分かりにくい形でしか現れなかった。
/// 保存時にも**まったく同じ規則**で弾けるよう、fs に依存しない部分をここへ出して
/// `select_gh_binary`(実行時) と `validate_gh_path` コマンド(保存時) の双方から呼ぶ。
/// 規則の実体が1か所しか無いので、二重に書いてズレることが原理的に起きない。
///
/// web 側 (`apps/web/src/sync/githubProvider.ts` の `validateGhPathOverride`) にも同じ規則の
/// 写しがあるが、そちらは**旧デスクトップシェル(このコマンドを持たないビルド)向けの
/// 保険と即時フィードバック**であって正ではない。正はここ。
///
/// # 規則
/// 1. **ファイル名が `gh`(Windows は `gh.exe`)であること** ―― セキュリティ上の制約。
///    フロントは本番サイト(リモート URL)を読む薄いガワで、その localStorage は XSS で
///    書き換えられうる(このファイル冒頭・`gh_api` のコメントの脅威モデル)。上書きパスを
///    そのまま spawn すると「gh 以外の任意のバイナリを選ばせる」余地になり、endpoint の
///    ホワイトリストで守っている「XSS でも任意コマンドは実行させない」境界が崩れる。
///    ディレクトリの自由指定は許すが、実行されるバイナリ名は gh に固定する。
/// 2. **絶対パスであること** ―― 相対パス(`bin/gh`、`../gh`、区切りを含まない裸の `gh`)は
///    プロセスの cwd を基準に解決されるが、Dock/Finder 起動のアプリの cwd は `/` などで
///    ユーザーの想像と一致しない。「保存はできるが効かない」の典型なので形の時点で断る
///    (ついでに `..` によるディレクトリ遡上も意味を失う)。
///
/// 空文字列は呼び出し側で「上書き解除(自動検出に戻す)」として扱うため、ここには渡らない。
fn validate_gh_override_shape(trimmed: &str) -> Result<(), String> {
    let path = std::path::Path::new(trimmed);
    let name = path.file_name().and_then(|n| n.to_str());
    if name != Some("gh") && name != Some("gh.exe") {
        return Err(format!(
            "gh という名前の実行ファイル(Windows は gh.exe)を指定してください: {trimmed}"
        ));
    }
    if !path.is_absolute() {
        return Err(format!(
            "gh のパスは絶対パスで指定してください(例: /opt/homebrew/bin/gh): {trimmed}"
        ));
    }
    Ok(())
}

/// 上書きパスが**実体として使えるか**を見る(fs に触れる部分)。
/// 形の検証 (`validate_gh_override_shape`) を通った後に呼ぶ。
///
/// 名前が gh でも実体が無ければ利用者にとっては同じ「効かない」なので、存在と実行可能性まで
/// 見る。逆に存在チェックは名前の制約の代わりにはならない(存在する任意のバイナリを
/// 選べてしまう)ので、**両方**必要。
fn validate_gh_override_file(path: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::metadata(path)
        .map_err(|_| format!("指定した gh のパスが存在しません: {}", path.display()))?;
    if !meta.is_file() {
        return Err(format!(
            "指定した gh のパスがファイルではありません: {}",
            path.display()
        ));
    }
    // 実行ビットの確認は unix のみ。Windows には対応する概念が無いので存在確認までで留める。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "指定した gh のパスは実行可能なファイルではありません: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

/// 使用する gh バイナリを決める。設定画面(web 側 localStorage)で明示パスが指定されていれば
/// (`gh_path`、Tauri のみ表示の「gh のパス」入力)それを検証して使い、空/未指定なら
/// `resolve_gh_path()` の自動検出にフォールバックする。
///
/// **実行時にも検証を残す理由**: 保存時 (`validate_gh_path` コマンド) だけで弾くと、
/// localStorage を直接書き換えられた場合(= 上記の XSS 脅威モデル)に素通りしてしまう。
/// **保存時は使い勝手のため、実行時は防御のため**という二重化であり、実行時の拒否は
/// 保存時チェックを足しても外せない。規則の実体は `validate_gh_override_shape` /
/// `validate_gh_override_file` の1組だけなので、二重化してもズレは生じない。
fn select_gh_binary(override_path: Option<String>) -> Result<std::path::PathBuf, String> {
    if let Some(p) = override_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            validate_gh_override_shape(trimmed)?;
            let path = std::path::PathBuf::from(trimmed);
            validate_gh_override_file(&path)?;
            return Ok(path);
        }
    }
    Ok(resolve_gh_path())
}

/// 設定画面の「gh のパス」を**保存する前に**検証する。問題なければ `None`、駄目なら
/// 理由の文字列を返す(`Err` ではなく戻り値にしているのは下記の理由)。
///
/// # なぜ command を足したか
/// 検証規則を web 側にも書き写すと必ずズレる。`select_gh_binary` をそのまま呼ぶ command を
/// 1つ生やせば、保存時のチェックが実行時とまったく同じコードを通る ―― 規則の写しが増えない。
/// 加えて、存在/実行可能性の確認はブラウザ側からは原理的にできず、ここでしかできない。
///
/// # なぜ `Result` の `Err` ではなく `Option<String>` か
/// invoke の失敗(このコマンドを持たない旧シェル、ACL 不許可など)と「シェルが答えた結果として
/// 不正」を web 側が区別できるようにするため。前者は reject、後者は resolve で返る。
/// 区別できないと、旧シェルで保存しようとしたときに検証エラーとして誤表示されてしまう。
///
/// 空文字列は「上書き解除」なので `None`(問題なし)。
///
/// 注: `gh_api` と同じくリモートコンテンツから invoke されるため capabilities/remote.json 側の
/// 明示許可が必要 (`allow-validate-gh-path`)。副作用は無く、パスの存在を答えるのは
/// ファイル名が gh のパスに限られる(形の検証が先に走るため)。
#[tauri::command]
fn validate_gh_path(gh_path: String) -> Option<String> {
    select_gh_binary(Some(gh_path)).err()
}

/// `gh api <endpoint>` を実行し stdout(GitHub REST の生 JSON 文字列)を返す。
///
/// - **非シェル実行**: `std::process::Command::new(<gh の実体パス>).arg("api").arg(endpoint)` で
///   直接プロセスを起動する。シェル(`sh -c`)を介さないため、`endpoint` に何が来ても
///   シェルインジェクションは起きない。呼べるのは常に `gh api <一引数>` だけで、
///   任意コマンド実行はできない(`endpoint` は search クエリ等の API パスのみを想定)。
/// - **パス解決**: `gh_path`(設定画面での上書き、任意)があればそれを、無ければ
///   `resolve_gh_path()` で実体を解決し(`select_gh_binary`)、`augmented_path()` で子プロセスの
///   PATH も補う(macOS の Dock 起動で Homebrew の gh が見つからない問題への対処)。
///   上書きパスの検証は設定画面の保存時にも走る(`validate_gh_path`)が、ここでの検証は
///   外せない ―― 保存時は使い勝手のため、実行時は防御のため(`select_gh_binary` のコメント参照)。
/// - **ホワイトリスト**: プロセス起動前に `is_allowed_gh_endpoint` で `endpoint` の
///   形状を検査する。web 側がリモート URL 経由で XSS を受けても、任意の GitHub
///   API を叩けないようにするための境界(ファイル先頭コメント・
///   `is_allowed_gh_endpoint` のドキュメントコメント参照)。`gh_path` は任意コマンド実行には
///   使えない(あくまで `gh` バイナリの場所指定であり、endpoint 側の制約は不変)。
/// - `gh` 不在は spawn 失敗として、未ログイン等の API エラーは非0終了の stderr として
///   分かるエラーメッセージにして Err で返す(web 側はフォールバックできる)。
///
/// 注: これはアプリ自前の command なので、Tauri v2 では capability(ACL)の追加許可は
/// 不要(プラグイン command と違い application command は invoke 可能)。
#[tauri::command]
async fn gh_api(endpoint: String, gh_path: Option<String>) -> Result<String, String> {
    if !is_allowed_gh_endpoint(&endpoint) {
        return Err(format!(
            "gh api endpoint がホワイトリスト外のため拒否しました: {endpoint}"
        ));
    }

    let gh_bin = select_gh_binary(gh_path)?;
    let output = std::process::Command::new(gh_bin)
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

/// 通知の1行あたりの上限文字数(char 単位)。
///
/// 予定のタイトルは長くなりうるし、リモート URL 側に XSS が刺さった場合の唯一の悪用口が
/// 「巨大な文言で通知を出す」なので、OS に渡す前に切り詰める。情報の持ち出しはできない
/// (このコマンドは何も返さない) ため、脅威としては迷惑行為に限られる。
const NOTIFY_MAX_CHARS: usize = 200;

/// 文字境界を壊さずに先頭 `max` 文字までに切り詰める。
///
/// `String::truncate` はバイト単位で、マルチバイト境界の途中で切ると panic するため
/// 使えない(予定のタイトルは日本語が普通)。
fn clamp_notify_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

/// web 側から呼ぶネイティブ通知。予定のリマインダー通知の送出口。
///
/// # なぜ判定を Rust に持たせないのか
/// この webview はリモート URL を読む薄いガワで、Rust 側は予定データを一切持っていない
/// (ファイル先頭コメント参照)。予定は web 側の IndexedDB にあるため、「いつ・どの予定を
/// 通知するか」の判定は web 側 (apps/web/src/sync/reminderSchedule.ts) が行い、
/// このコマンドは渡された文言をそのまま OS に流すだけにしている。
/// 裏返すと、通知が出るのはアプリのプロセスが動いている間だけ ―― ただしウィンドウの
/// 「閉じる」ではプロセスは終わらない (下記 on_window_event) ので、トレイに隠したままでも
/// 通知は続く。
///
/// # 権限について
/// tauri-plugin-notification の desktop 実装 (2.3.3 src/desktop.rs) は実際の送出を
/// 別タスクへ spawn して結果を捨てているため、**macOS で通知が拒否されていても
/// エラーは返ってこない**。`permission_state()` も desktop では常に `Granted` を返す
/// ハードコードなので判定に使えない。つまり「許可されているか」をプログラムから知る術は
/// 無いので、設定画面の「テスト通知を送る」で利用者自身に確かめてもらう方針にしている
/// (apps/web/src/components/SettingsModal.tsx の ReminderControl)。
/// ここで `Err` になるのは invoke 到達後にビルダーが失敗した場合のみ (実質 Windows 等)。
///
/// 注: `gh_api` と同じくリモートコンテンツから invoke されるため、capabilities/remote.json
/// 側の明示許可 (`allow-notify`) が無いと ACL で全拒否される。プラグインの
/// `notification:default` をリモートへ与える代わりに自前コマンド1本に絞っているのは、
/// XSS 時に触れる面をこの1本だけにするため(スケジュール済み通知の一覧・削除といった
/// プラグインの他 API を晒さない)。
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(clamp_notify_text(&title, NOTIFY_MAX_CHARS))
        .body(clamp_notify_text(&body, NOTIFY_MAX_CHARS))
        .show()
        .map_err(|e| format!("通知の送出に失敗しました: {e}"))
}

// ============================================================================
// 外部ブラウザ OAuth（増分2d、2026-08-07）
// ============================================================================

/// アプリへ戻ってくるためのカスタム URL スキーム。
/// `tauri.conf.json` の `plugins.deep-link.desktop.schemes` と、Worker 側の
/// `apps/sync/src/core/desktop-auth.ts` の `DESKTOP_DEEP_LINK_SCHEME` の**3箇所**が
/// 一致していないと、認証が無言で詰まる（OS がアプリを見つけられない / アプリが
/// 受け取っても自分宛だと判定しない）。
const DEEP_LINK_SCHEME: &str = "kichijitsu";

/// 外部ブラウザで始めた認証の verifier を1件だけ保持する。
///
/// # なぜアプリ（Rust）側に持つのか
/// この値は「いま開いている認証を始めたのは、まさにこのアプリだ」という証明に使う
/// （PKCE 相当。詳細は apps/sync/src/core/desktop-auth.ts のコメント）。外部ブラウザには
/// SHA-256 を取ったもの（challenge）しか渡さないので、URL が履歴やブラウザ同期経由で
/// 漏れても、この verifier は復元できない。
///
/// webview の JS 側ではなく Rust に置いているのは (1) webview がリロードされても失われない、
/// (2) リモート URL 側に XSS が刺さっても読み出せない、の2点のため。
///
/// **ディスクには保存しない。** 認証の途中でアプリを完全終了 (トレイの「終了」) すると
/// verifier は失われ、戻ってきたディープリンクは無視される (利用者はもう一度
/// 「Google 連携」を押すだけでよい)。数分だけ生きる秘密をファイルに書いて残す方が
/// リスクが大きく、しかもウィンドウの「閉じる」ではプロセスは終わらない (下記
/// on_window_event) ため、実際にこの経路に落ちるのは稀。
///
/// 常に**最後に開始した1件**だけを保持する。認証を2回続けて始めたら古い方は捨てられ、
/// 古い方のディープリンクが後から届いても verifier が合わずに失敗する ―― 認証は
/// ユーザーが1つずつ行う操作なので、これで困ることは無い。
#[derive(Default)]
struct PendingExternalLogin(Mutex<Option<String>>);

/// バイト列を小文字 hex にする（Worker 側の bytesToHex と同じ表現）。
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 バイトの暗号論的乱数を小文字 hex（64文字）で返す。
///
/// `std` には CSPRNG が無いため getrandom を使う。ここで推測可能な値を使うと、
/// 「アプリと認証の結び付け」という PendingExternalLogin の目的そのものが崩れる。
fn random_hex_32() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).map_err(|e| format!("乱数の生成に失敗しました: {e}"))?;
    Ok(to_hex(&buf))
}

/// SHA-256 を小文字 hex で返す。Worker 側の `hashDesktopSecret` と同じ表現
/// （テストで SHA-256("abc") の既知ベクタを両側に置いて突き合わせている）。
fn sha256_hex(input: &str) -> String {
    to_hex(&Sha256::digest(input.as_bytes()))
}

/// web 側から渡された相対パスを、外部ブラウザで開く絶対 URL に組み立てる**純関数**。
///
/// # 脅威モデル
/// `path` の出所はリモート URL を読む webview（＝ XSS が刺さりうる、lib.rs 冒頭と
/// `gh_api` のコメント参照）なので、そのまま既定ブラウザへ渡してはいけない。
/// `is_allowed_gh_endpoint` と同じ考え方で、**web 側が実際に使う形だけを許可する**:
///
/// 1. 制御文字を含まないこと（URL/ヘッダの行インジェクション対策）
/// 2. `"/auth/login"` そのもの、または `"/auth/login?"` で始まること
///    （`//evil.example.com/...` のようなプロトコル相対 URL もここで落ちる）
/// 3. 解決後のオリジンが、webview が今読んでいるオリジンと同一であること（二重の保険）
///
/// この3つを通すと、XSS が open_external_login を叩けても「自分のサイトのログイン画面を
/// 既定ブラウザで開く」以上のことはできない。
///
/// オリジンを web 側で組み立てず webview の現在 URL から取るのは、公式インスタンスの
/// ホスト名を `apps/web` に書かないため（セルフホスト時に漏れる）。この関数が使う
/// `current` は tauri.conf.json のウィンドウ URL に由来する＝既存の設定経路そのもの。
fn build_external_login_url(current: &Url, path: &str, challenge: &str) -> Result<String, String> {
    if path.chars().any(|c| c.is_ascii_control()) {
        return Err("ログイン URL に制御文字が含まれています".to_string());
    }
    if path != "/auth/login" && !path.starts_with("/auth/login?") {
        return Err(format!("許可されていないログイン URL です: {path}"));
    }
    let joined = current
        .join(path)
        .map_err(|e| format!("ログイン URL を解決できませんでした: {e}"))?;
    if joined.origin() != current.origin() {
        return Err("ログイン URL のオリジンがアプリのものと一致しません".to_string());
    }
    // `desktop=1` と `dc`（challenge）は**アプリだけ**が足す。web 側に足させると、
    // XSS が自分で作った challenge を仕込めてしまい結び付けの意味が無くなる。
    let separator = if joined.query().is_some() { '&' } else { '?' };
    Ok(format!("{joined}{separator}desktop=1&dc={challenge}"))
}

/// チケットの形式（Worker 側の `isValidDesktopTicketFormat` と同じ規則: base64url 43文字）。
/// ディープリンクは誰でも投げられるので、webview に踏ませる前にここで形を確かめる。
fn is_valid_ticket(value: &str) -> bool {
    value.len() == 43
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// 受け取ったディープリンクが自分宛の認証コールバックなら、チケットを取り出す**純関数**。
///
/// 期待する形は `kichijitsu://auth?ticket=<43文字>`。ホストの扱いは OS/URL パーサによって
/// `host = "auth"` にも `path = "/auth"` にもなりうるため、どちらも受け付ける。
/// スキーム・宛先・チケット形式のどれかが違えば `None`（＝何もしない）。
fn extract_ticket_from_deep_link(url: &Url) -> Option<String> {
    if url.scheme() != DEEP_LINK_SCHEME {
        return None;
    }
    let targets_auth = url.host_str() == Some("auth")
        || (url.host_str().is_none() && matches!(url.path().trim_matches('/'), "auth"));
    if !targets_auth {
        return None;
    }
    let ticket = url
        .query_pairs()
        .find(|(k, _)| k == "ticket")
        .map(|(_, v)| v.into_owned())?;
    if !is_valid_ticket(&ticket) {
        return None;
    }
    Some(ticket)
}

/// チケットとverifierを webview に踏ませる交換 URL を組み立てる**純関数**。
///
/// なぜ webview を**ナビゲート**させるのか: セッション Cookie は「そのレスポンスを受け取った
/// Cookie ジャー」にしか入らない。Rust から fetch して Cookie を手で移す細工をするより、
/// webview 自身にこの GET を踏ませるのが確実かつ単純。
fn build_exchange_url(current: &Url, ticket: &str, verifier: &str) -> Result<String, String> {
    if !is_valid_ticket(ticket) {
        return Err("チケットの形式が正しくありません".to_string());
    }
    if verifier.len() != 64 || !verifier.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("verifier の形式が正しくありません".to_string());
    }
    let base = current
        .join("/auth/desktop/exchange")
        .map_err(|e| format!("交換 URL を解決できませんでした: {e}"))?;
    // ticket は base64url、verifier は hex なので、いずれも URL エスケープ不要
    // （形式検査を通っている＝ `&`/`?`/空白などは含まれない）。
    Ok(format!("{base}?ticket={ticket}&verifier={verifier}"))
}

/// メインウィンドウが今読んでいる URL（＝ tauri.conf.json のウィンドウ URL に由来する
/// 本番/セルフホストのオリジン）を返す。
fn main_window_url(app: &tauri::AppHandle) -> Result<Url, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "メインウィンドウが見つかりません".to_string())?;
    window
        .url()
        .map_err(|e| format!("webview の URL を取得できませんでした: {e}"))
}

/// Google 連携を **OS の既定ブラウザ** で開始する（web 側 sync/desktopAuth.ts から invoke）。
///
/// `path` は `/auth/login` または `/auth/login?...`（add モードの `add_token` / `login_hint`）
/// の相対パスだけを受け付ける（`build_external_login_url` の脅威モデル参照）。
/// verifier はここで作ってアプリ内に保持し、外部ブラウザへは SHA-256 を取った
/// challenge しか渡さない。
///
/// 注: `gh_api` と同じくリモートコンテンツから invoke されるため capabilities/remote.json の
/// `allow-open-external-login` が必要。
#[tauri::command]
fn open_external_login(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let current = main_window_url(&app)?;
    let verifier = random_hex_32()?;
    let url = build_external_login_url(&current, &path, &sha256_hex(&verifier))?;

    // ブラウザを開く前に保存する。開いた後だと、極端に速い復帰（ブラウザが既にその
    // サイトにログイン済みで即リダイレクトする場合）でディープリンクの方が先に届き、
    // 「verifier がまだ無い」で自分の認証を取りこぼしうる。
    //
    // 保存できなかった場合はブラウザを**開かずに**エラーを返す。開いてしまうと、
    // 利用者は同意画面まで進んだのに最後の交換だけが必ず失敗する（何が悪いのか
    // 分からない）という一番たちの悪い失敗になる。
    {
        let state = app.state::<PendingExternalLogin>();
        let mut pending = state
            .0
            .lock()
            .map_err(|_| "認証の状態を保存できませんでした".to_string())?;
        *pending = Some(verifier);
    }

    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| format!("既定のブラウザを開けませんでした: {e}"))
}

/// `kichijitsu://auth?ticket=...` を受け取ったときの処理。
///
/// 保持していた verifier を **take（取り出して即座に消す）** ことで、アプリ側でも
/// 1回のディープリンクにつき1回しか交換を試みない。verifier が無い状態で届いた
/// ディープリンクは「このアプリが始めた認証ではない」＝ 悪意あるリンクを踏まされた
/// 可能性があるので、何もせずログだけ残す（サーバー側でも challenge 照合で弾かれる）。
fn handle_auth_deep_link(app: &tauri::AppHandle, url: &Url) {
    let Some(ticket) = extract_ticket_from_deep_link(url) else {
        eprintln!("kichijitsu: 認証コールバックとして解釈できないディープリンクを無視しました");
        return;
    };
    let verifier = app
        .state::<PendingExternalLogin>()
        .0
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    let Some(verifier) = verifier else {
        eprintln!("kichijitsu: 進行中の認証が無いのにディープリンクを受け取りました（無視します）");
        return;
    };

    let Ok(current) = main_window_url(app) else {
        return;
    };
    match build_exchange_url(&current, &ticket, &verifier) {
        Ok(exchange_url) => match Url::parse(&exchange_url) {
            Ok(parsed) => {
                if let Some(window) = app.get_webview_window("main") {
                    // 外部ブラウザから戻ってきた直後はアプリが背面/トレイにいることが多い。
                    // 交換の結果（成功なら通常画面、失敗なら理由のページ）が見えるように前へ出す。
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    if let Err(e) = window.navigate(parsed) {
                        eprintln!("kichijitsu: 認証の仕上げに失敗しました: {e}");
                    }
                }
            }
            Err(e) => eprintln!("kichijitsu: 交換 URL を組み立てられませんでした: {e}"),
        },
        Err(e) => eprintln!("kichijitsu: 交換 URL を組み立てられませんでした: {e}"),
    }
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
        // 外部ブラウザ OAuth（増分2d、2026-08-07）。`kichijitsu://` の OS への登録は
        // tauri.conf.json の plugins.deep-link.desktop.schemes が担い、このプラグインは
        // 受け取ったディープリンクをアプリへ届ける。
        //
        // ブラウザを開く側の tauri-plugin-opener は**あえて登録しない** ―― Rust の自由関数
        // `open_url` だけを使う。登録すると webview（リモート URL）から「任意の URL や
        // ローカルファイルを開く」コマンドが叩けるようになってしまい、gh_api と同じ脅威モデル
        // （ファイル冒頭のコメント）で晒す面が増えるため。
        .plugin(tauri_plugin_deep_link::init())
        // 進行中の認証の verifier 置き場（PendingExternalLogin のコメント参照）。
        .manage(PendingExternalLogin::default())
        .invoke_handler(tauri::generate_handler![
            gh_api,
            app_version,
            validate_gh_path,
            notify,
            open_external_login
        ])
        .setup(|app| {
            // --- 外部ブラウザ OAuth の復帰口 ---
            // `kichijitsu://auth?ticket=...` を受け取ったら、保持している verifier を添えて
            // webview を /auth/desktop/exchange へナビゲートする（handle_auth_deep_link）。
            //
            // 注意（macOS）: スキームの登録は **バンドルされたアプリ** に対して行われるため、
            // `tauri dev` で起動した状態ではディープリンクが届かないことがある。動作確認は
            // `pnpm build:desktop` で作った .app から行うこと。
            // 注意（Windows/Linux）: これらの OS ではディープリンクがアプリの**新しい
            // インスタンス**として起動される（プラグインの README 参照）。同じ挙動に
            // そろえるには tauri-plugin-single-instance の deep-link feature が要るが、
            // 現状の配布対象は macOS（apps/desktop/homebrew/kichijitsu.rb）なので、
            // ライブラリを増やさない方針を優先して今回は入れていない。
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_auth_deep_link(&handle, &url);
                    }
                });
            }

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

            // --- ネイティブ通知 ---
            // 起動時にテスト通知を出していた土台のコードは削除した。予定の
            // リマインダーが実際に配線された今、毎回の起動で意味の無い通知が出るのは
            // 邪魔なだけ。通知が出るかどうかを確かめたい人向けには、設定画面の
            // 「テスト通知を送る」ボタン(web 側から notify コマンドを呼ぶ)がある。
            // 送出は #[tauri::command] fn notify、いつ出すかの判定は web 側
            // (apps/web/src/sync/reminderSchedule.ts)。

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

    // --- 8. validate_gh_override_shape: 形の規則(名前が gh / 絶対パス) ---
    //
    // この境界表は web 側の写し (apps/web/src/sync/githubProvider.ts の
    // validateGhPathOverride、テストは githubProvider.test.ts) と**同じ並び**で保つ。
    // 規則の正はこちら側なので、食い違ったら web 側を直す。

    #[test]
    fn shape_accepts_absolute_path_named_gh() {
        assert!(validate_gh_override_shape("/opt/homebrew/bin/gh").is_ok());
        assert!(validate_gh_override_shape("/usr/local/bin/gh").is_ok());
        // Windows 実行ファイル名。POSIX 上でも「名前」の判定としては通す
        // (絶対パス判定は OS 依存なので、ここでは POSIX 形の絶対パスで確かめる)。
        assert!(validate_gh_override_shape("/opt/homebrew/bin/gh.exe").is_ok());
    }

    #[test]
    fn shape_rejects_non_gh_file_name() {
        // XSS で localStorage を書き換えられても、gh 以外の任意バイナリは選ばせない。
        let err = validate_gh_override_shape("/tmp/evil").unwrap_err();
        assert!(err.contains("gh という名前"), "got: {err}");
        assert!(validate_gh_override_shape("/usr/bin/gh2").is_err());
        assert!(validate_gh_override_shape("/usr/bin/git").is_err());
        // ディレクトリを指す末尾スラッシュは file_name が "bin" になるので拒否。
        assert!(validate_gh_override_shape("/opt/homebrew/bin/").is_err());
    }

    #[test]
    fn shape_ignores_trailing_slash_after_gh() {
        // Path::file_name は末尾スラッシュを無視して "gh" を返すため、形としては通る。
        // 実体がディレクトリだった場合は validate_gh_override_file が
        // 「ファイルではありません」で弾く(形と実体で役割を分けている)。
        assert!(validate_gh_override_shape("/opt/homebrew/bin/gh/").is_ok());
    }

    #[test]
    fn shape_rejects_relative_paths() {
        // 区切りを含まない裸の gh・相対パス・.. 入りは、GUI 起動プロセスの cwd 次第に
        // なってしまうため形の時点で断る。
        for p in ["gh", "bin/gh", "./gh", "../gh", "../../opt/homebrew/bin/gh"] {
            let err = validate_gh_override_shape(p).unwrap_err();
            assert!(err.contains("絶対パス"), "{p}: {err}");
        }
        // 絶対パスであれば .. を含んでいても通す(正規化した先が gh である保証は
        // validate_gh_override_file の存在確認が担う)。
        assert!(validate_gh_override_shape("/opt/homebrew/bin/../bin/gh").is_ok());
    }

    // --- 9. select_gh_binary: 形 + 実体の検証を通しで ---

    #[test]
    fn select_gh_binary_rejects_non_gh_basename() {
        let err = select_gh_binary(Some("/tmp/evil".to_string())).unwrap_err();
        assert!(err.contains("gh という名前"), "got: {err}");
    }

    #[test]
    fn select_gh_binary_rejects_missing_gh_path() {
        // 名前は gh だが実在しないパスは「存在しません」で明示エラー。
        let err = select_gh_binary(Some("/no/such/dir/gh".to_string())).unwrap_err();
        assert!(err.contains("存在しません"), "got: {err}");
    }

    #[test]
    fn select_gh_binary_empty_or_none_falls_back_to_auto_detect() {
        // 空/空白/未指定は自動検出にフォールバックする(resolve_gh_path、常に Ok)。
        assert!(select_gh_binary(None).is_ok());
        assert!(select_gh_binary(Some("".to_string())).is_ok());
        assert!(select_gh_binary(Some("   ".to_string())).is_ok());
    }

    // --- 10. validate_gh_path コマンド: 保存時の検証が実行時と同じ判定を返す ---

    #[test]
    fn validate_gh_path_returns_none_for_empty_and_message_for_invalid() {
        // 空 = 上書き解除なので問題なし。
        assert_eq!(validate_gh_path(String::new()), None);
        assert_eq!(validate_gh_path("  ".to_string()), None);
        // 不正なパスは理由の文字列で返る(reject ではなく戻り値。コマンドのコメント参照)。
        let msg = validate_gh_path("/usr/bin/git".to_string()).expect("拒否されるはず");
        assert!(msg.contains("gh という名前"), "got: {msg}");
        // 保存時と実行時が同じ判定であること = 同じ関数を通っていることの確認。
        for p in ["/usr/bin/git", "gh", "/no/such/dir/gh"] {
            assert_eq!(
                validate_gh_path(p.to_string()),
                select_gh_binary(Some(p.to_string())).err(),
                "{p}"
            );
        }
    }

    #[test]
    fn validate_gh_path_accepts_real_executable_named_gh() {
        // 実体の検証(存在 + 実行ビット)が「本物」を通すことを、テスト用に作った
        // 実行可能ファイルで確かめる。gh CLI が入っていない CI でも成立させたいので
        // 一時ディレクトリに自前で置く。
        let dir = std::env::temp_dir().join(format!("kichijitsu-gh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("gh");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = bin.to_string_lossy().to_string();
        assert_eq!(validate_gh_path(path.clone()), None);
        assert_eq!(select_gh_binary(Some(path)).unwrap(), bin);

        // 実行ビットが無ければ「実行可能なファイルではありません」で弾く(unix のみ)。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
            let msg = validate_gh_path(bin.to_string_lossy().to_string()).expect("拒否されるはず");
            assert!(msg.contains("実行可能"), "got: {msg}");
        }

        // ディレクトリを gh という名前で作った場合は「ファイルではありません」。
        let dir_named_gh = dir.join("sub").join("gh");
        std::fs::create_dir_all(&dir_named_gh).unwrap();
        let msg =
            validate_gh_path(dir_named_gh.to_string_lossy().to_string()).expect("拒否されるはず");
        assert!(msg.contains("ファイルではありません"), "got: {msg}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // --- 通知の文言の切り詰め (clamp_notify_text) ---

    #[test]
    fn clamp_notify_text_keeps_short_text_as_is() {
        assert_eq!(clamp_notify_text("週次定例", 200), "週次定例");
        // ちょうど上限は切らない
        assert_eq!(clamp_notify_text("あいうえお", 5), "あいうえお");
    }

    #[test]
    fn clamp_notify_text_truncates_on_char_boundary() {
        // 日本語(マルチバイト)でも panic せず、char 単位で数える。
        // String::truncate のバイト単位切りだと境界の途中で panic する。
        assert_eq!(clamp_notify_text("あいうえおかきくけこ", 5), "あいうえ…");
        // 末尾は省略記号1文字を含めて上限ぴったり
        assert_eq!(clamp_notify_text("あいうえおかきくけこ", 5).chars().count(), 5);
    }

    #[test]
    fn clamp_notify_text_handles_degenerate_limits() {
        // max が 0/1 でも panic しない (saturating_sub のおかげ)
        assert_eq!(clamp_notify_text("abc", 1), "…");
        assert_eq!(clamp_notify_text("abc", 0), "…");
        assert_eq!(clamp_notify_text("", 0), "");
    }

    // --- 外部ブラウザ OAuth (増分2d、2026-08-07) ---

    fn app_origin() -> Url {
        // 実際の webview は tauri.conf.json のウィンドウ URL (…/app) を読んでいる。
        Url::parse("https://kichijitsu.example.test/app").unwrap()
    }

    #[test]
    fn sha256_hex_matches_the_worker_side() {
        // apps/sync/test/desktop-auth.test.ts に置いてある既知ベクタと同じ値。
        // ここが食い違うと challenge の照合が永久に通らない (認証が無言で失敗する)。
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn random_hex_32_is_64_lowercase_hex_and_not_repeated() {
        let a = random_hex_32().unwrap();
        let b = random_hex_32().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(a, b);
    }

    #[test]
    fn build_external_login_url_appends_desktop_markers() {
        let challenge = "a".repeat(64);
        // クエリなし: `?` で始める。
        assert_eq!(
            build_external_login_url(&app_origin(), "/auth/login", &challenge).unwrap(),
            format!("https://kichijitsu.example.test/auth/login?desktop=1&dc={challenge}")
        );
        // 既にクエリがある (add モード): `&` で継ぎ足す。
        assert_eq!(
            build_external_login_url(
                &app_origin(),
                "/auth/login?add=1&login_hint=a%40b.c&add_token=t",
                &challenge
            )
            .unwrap(),
            format!(
                "https://kichijitsu.example.test/auth/login?add=1&login_hint=a%40b.c&add_token=t&desktop=1&dc={challenge}"
            )
        );
    }

    #[test]
    fn build_external_login_url_rejects_anything_but_the_login_path() {
        let challenge = "a".repeat(64);
        for path in [
            // 別オリジンへ誘導しようとするもの (XSS が最も狙う形)
            "https://evil.example.com/auth/login",
            "//evil.example.com/auth/login",
            // ログイン以外のパス (既定ブラウザで勝手に開かせない)
            "/auth/logout",
            "/app",
            "/auth/loginX",
            "file:///etc/passwd",
            // 相対パス・空
            "auth/login",
            "",
            // 制御文字混入
            "/auth/login?add=1\r\nX-Evil: 1",
        ] {
            assert!(
                build_external_login_url(&app_origin(), path, &challenge).is_err(),
                "許可されてはいけない path が通った: {path}"
            );
        }
    }

    #[test]
    fn extract_ticket_from_deep_link_accepts_the_expected_shape() {
        let ticket = "a".repeat(43);
        let url = Url::parse(&format!("kichijitsu://auth?ticket={ticket}")).unwrap();
        assert_eq!(
            extract_ticket_from_deep_link(&url).as_deref(),
            Some(&ticket[..])
        );
        // base64url の記号 (- と _) を含むチケットも通る。
        let symbolic = format!("{}-_", "b".repeat(41));
        let url = Url::parse(&format!("kichijitsu://auth?ticket={symbolic}")).unwrap();
        assert_eq!(
            extract_ticket_from_deep_link(&url).as_deref(),
            Some(&symbolic[..])
        );
    }

    #[test]
    fn extract_ticket_from_deep_link_rejects_foreign_or_malformed_links() {
        let ticket = "a".repeat(43);
        for raw in [
            // 別スキーム (他アプリ向けのリンクを拾わない)
            &format!("https://kichijitsu.example.test/auth?ticket={ticket}"),
            &format!("evil://auth?ticket={ticket}"),
            // 宛先が auth ではない
            &format!("kichijitsu://other?ticket={ticket}"),
            // チケットが無い / 形式が違う
            "kichijitsu://auth",
            "kichijitsu://auth?ticket=",
            &format!("kichijitsu://auth?ticket={}", "a".repeat(42)),
            &format!("kichijitsu://auth?ticket={}", "a".repeat(44)),
            "kichijitsu://auth?ticket=aaaa+aaaa",
        ] {
            let url = Url::parse(raw).unwrap();
            assert!(
                extract_ticket_from_deep_link(&url).is_none(),
                "受け付けてはいけないディープリンクが通った: {raw}"
            );
        }
    }

    #[test]
    fn build_exchange_url_uses_the_app_origin_and_validates_both_secrets() {
        let ticket = "a".repeat(43);
        let verifier = "1".repeat(64);
        assert_eq!(
            build_exchange_url(&app_origin(), &ticket, &verifier).unwrap(),
            format!(
                "https://kichijitsu.example.test/auth/desktop/exchange?ticket={ticket}&verifier={verifier}"
            )
        );
        // 形式が違うものは URL を組み立てない (webview に踏ませない)。
        assert!(build_exchange_url(&app_origin(), "short", &verifier).is_err());
        assert!(build_exchange_url(&app_origin(), &ticket, "short").is_err());
        assert!(build_exchange_url(&app_origin(), &ticket, &"z".repeat(64)).is_err());
        // クエリ/フラグメント混入で URL を壊そうとする値も形式検査で落ちる。
        assert!(
            build_exchange_url(&app_origin(), &format!("{}&x=1", "a".repeat(39)), &verifier)
                .is_err()
        );
    }

    #[test]
    fn deep_link_scheme_is_shared_with_the_config_and_the_worker() {
        // tauri.conf.json の plugins.deep-link.desktop.schemes と
        // apps/sync/src/core/desktop-auth.ts の DESKTOP_DEEP_LINK_SCHEME と同じ値であること。
        assert_eq!(DEEP_LINK_SCHEME, "kichijitsu");
    }
}
