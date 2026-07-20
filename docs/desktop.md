# デスクトップアプリ (Tauri 2)

`apps/desktop` は Tauri 2 製の kichijitsu デスクトップシェル。方針は
docs/multiplatform.md の「Tauri 2 デスクトップ: まずリモート URL 方式」に従う
（2026-07-21 増分1で追加。同日、増分2a でトレイ常駐・グローバルショートカット・
ネイティブ通知の土台を追加）。

## 増分1: リモート URL 方式（今回作ったもの）

**フロントエンドは同梱しない。** webview は本番サイト
`https://kichijitsu.love-rox.cc` をそのまま読むだけの薄いガワ。

- OAuth（Google / GitHub）・cookie・CORS はすべて本番と同一オリジンで完結する
  ため、デスクトップ側で作り込みが要らない。ログインフローは Web 版と完全に
  同じ挙動になる
- Tauri コマンド（invoke ハンドラ）は無し。`src-tauri/src/lib.rs` は
  `tauri::Builder::default()` を起動するだけ
- `capabilities/default.json` は `core:default` のみ。remote 側から Tauri IPC
  を呼ぶ必要が無いため、`remote.urls` によるドメイン許可も設定していない
- **CSP は意図的に `null`（無効）にしている。** Tauri の `app.security.csp` は
  Tauri 自身が配信するコンテンツ（`frontendDist` のローカルアセット /
  `tauri://` アセットプロトコル）にだけ CSP を注入する機構で、今回のように
  window がリモート HTTPS URL を直接読む構成には効かない（配信元サーバーの
  レスポンスヘッダが支配する）。無効な CSP 文字列を無意味に足すよりは
  `null` のままにして、意図をここに明記する方針にした。将来 CSP を強化する
  なら、本番サイト側（Cloudflare Worker のレスポンスヘッダ）で設定する話に
  なる
- ウィンドウ: タイトル `kichijitsu`、初期サイズ 1200x800、最小サイズ
  480x600
- `identifier`: `cc.love-rox.kichijitsu`
- アイコン: `brand/tile.svg` から `tauri icon` コマンドで生成
  （`src-tauri/icons/`。PWA アイコン生成 `brand/gen-pwa-icons.js` と同じソース）

### 構成

```
apps/desktop/
  package.json          # @tauri-apps/cli のみ devDependency。scripts: dev/build
  src-tauri/
    tauri.conf.json      # productName/identifier/window/icon/bundle
    Cargo.toml            # tauri 2 (tray-icon feature) + global-shortcut/notification プラグイン
    build.rs
    src/
      main.rs
      lib.rs              # setup() でトレイ/グローバルショートカット/通知を配線（増分2a）
    capabilities/
      default.json        # core:default + global-shortcut/notification の最小許可
    icons/                # tauri icon で生成した icns/ico/png 一式
```

## 増分2a: トレイ常駐・グローバルショートカット・ネイティブ通知

増分1のリモート URL 方式の上に、OS ネイティブなシェル機能を **`apps/desktop` の
Rust 側のみ**で追加した（フロントを同梱していないため、フロントからは制御でき
ない。すべて `src-tauri/src/lib.rs` の `setup()` 内で完結）。

- **トレイ常駐**（Tauri 2 コア機能 `tray-icon`、プラグインではない）
  - `Cargo.toml` に `tauri = { version = "2", features = ["tray-icon"] }`
  - アイコンは `app.default_window_icon()`（既存 `src-tauri/icons/` を流用、
    新規アイコン追加なし）
  - メニュー: 「表示/隠す」「終了」。**左クリックは表示/隠すトグル専用**にし、
    メニューは右クリックでのみ開く（`show_menu_on_left_click(false)`）
  - ウィンドウの「閉じる」（× ボタン、macOS の赤信号含む）はアプリを終了させ
    ず、`WindowEvent::CloseRequested` で `api.prevent_close()` + `window.hide()`
    してトレイに格納する。**アプリの終了はトレイメニューの「終了」
    (`app.exit(0)`) のみ**
- **グローバルショートカット**（`tauri-plugin-global-shortcut` 2.x、デスクトップ
  専用プラグインのため `Cargo.toml` で `target.'cfg(any(target_os = "macos",
windows, target_os = "linux"))'.dependencies` に限定）
  - **`CmdOrCtrl+Shift+K`** でウィンドウの表示/隠すをトグル（トレイ左クリックと
    同じ `toggle_main_window()` を呼ぶ）。定数 `TOGGLE_WINDOW_SHORTCUT` として
    `lib.rs` 冒頭にコメント付きで定義
- **ネイティブ通知**（`tauri-plugin-notification` 2.x）は**配線の土台まで**。
  プラグインを有効化し、起動時に1回テスト通知（「トレイ常駐・グローバル
  ショートカット・通知の土台が起動しました」）を出すところまでで、実際の
  予定リマインダー通知は未配線（下記「残 TODO」参照）
- `capabilities/default.json` に `global-shortcut:allow-register` /
  `allow-unregister` / `allow-is-registered` と `notification:default` を追加。
  ただし今回追加した機能はすべて Rust の `setup()` から直接プラグイン API を
  呼んでおり、webview からの `invoke()` を経由しないため、capability の許可が
  無くても動作する。将来フロントから同じ機能を呼ぶ場合に備えた最小限の明示
  という位置づけ（`core:tray:*` は `core:default` に既に含まれるため追加不要）

### 使い方

- トレイアイコンを**左クリック**: ウィンドウの表示/隠すをトグル（隠れていれば
  表示して前面へ、表示中なら隠す）
- トレイアイコンを**右クリック**: 「表示/隠す」「終了」メニューを表示
- **`CmdOrCtrl+Shift+K`**（macOS は Cmd、Windows/Linux は Ctrl）: どこからでも
  ウィンドウの表示/隠すをトグル（トレイ左クリックと同じ動作）
- ウィンドウを閉じてもアプリは終了せずトレイに残る。完全終了はトレイメニュー
  の「終了」から

### 残 TODO: 実リマインダーのフロント連携

予定のリマインダー通知（Web 版の VAPID Web Push 相当）をネイティブ通知に置き
換えるには、フロント(リモート URL の web アプリ)側から Tauri コマンドを呼ぶ
配線が必要（今回はやらない、次増分）。想定する形:

1. `#[tauri::command]` でフロントから呼べる通知コマンド（例:
   `fn notify(title: String, body: String)`）を追加
2. `capabilities/default.json` の `notification:*` 許可をそのコマンド用に絞り
   込む
3. Web 版のリマインダースケジューリングロジックから、デスクトップ実行時のみ
   その Tauri コマンドを呼ぶ分岐を追加（`window.__TAURI__` の有無で判定、また
   は `@tauri-apps/api` の環境検出）

## ビルド・実行手順

Rust 未導入なら先に `rustup` で導入する:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

その後:

```sh
pnpm install
pnpm --filter desktop dev     # 開発起動（= pnpm dev:desktop）
pnpm --filter desktop build   # リリースビルド（= pnpm build:desktop）
```

`pnpm --filter desktop build` は OS ごとのネイティブバイナリ/インストーラ
（macOS: .app/.dmg、Windows: .exe/.msi、Linux: .deb/.AppImage 等）を
`apps/desktop/src-tauri/target/` 配下に生成する。フロントエンドのビルドは
不要（リモート URL を読むだけなので `frontendDist` にもローカル URL
`https://kichijitsu.love-rox.cc` を指定している）。

## 検証した範囲（このエージェントによる作業時点）

この環境には `cargo`/`rustc` (1.92.0) と `pnpm dlx @tauri-apps/cli` (2.11.4)
が使えたため、以下を実施・確認済み:

- `pnpm dlx @tauri-apps/cli init` で生成される Tauri 2 の雛形と見比べて
  `tauri.conf.json` のスキーマ（`build.frontendDist` / `app.windows[].url`
  にリモート URL を指定する書式）が現行の Tauri 2 と整合していることを確認
- `tauri icon brand/tile.svg -o apps/desktop/src-tauri/icons` でアイコン一式
  を生成
- **`cargo check`（`apps/desktop/src-tauri/` 配下）を実行し成功を確認済み**
  （`Finished dev profile [unoptimized + debuginfo] target(s) in 28.53s`。
  `tauri`/`tauri-build` 依存を含め crates.io からの取得・コンパイルまで通った）
- `pnpm --filter desktop exec tauri --version` で workspace 内から CLI が
  解決できることを確認（`tauri-cli 2.11.4`）
- `pnpm install` がワークスペース全体で通ること、`apps/web` /
  `apps/sync` の `typecheck` が引き続き 0 のままであることを確認
- ネイティブバイナリのフルビルド（`cargo build --release` / `tauri build`
  でのインストーラ生成まで）は重いため未実行。`tauri dev` での実機起動・
  ウィンドウ表示・ログイン動作の確認はユーザー側で行ってほしい

### 増分2a で検証した範囲

- `tauri-plugin-global-shortcut` 2.3.2 / `tauri-plugin-notification` 2.3.3 /
  `tauri` 2.11.5（`tray-icon` feature）を Cargo.toml に追加し、
  **`cargo check`（`apps/desktop/src-tauri/` 配下）が成功することを確認済み**
  （crates.io からの新規取得・コンパイルまで通った。警告無し）
- 現行の Tauri 2 API（v2.tauri.app の System Tray / Global Shortcut /
  Notification 各ガイド、docs.rs の `tauri::tray` / `GlobalShortcutExt` /
  `NotificationExt`）を web で確認し、その通りの書式で実装
- `pnpm --filter web run typecheck` / `pnpm --filter sync run typecheck` が
  引き続き 0 のままであることを確認（desktop 以外は無変更）
- `pnpm exec vp fmt --check`（リポジトリ全体、279 ファイル）が整形済みである
  ことを確認。今回変更した `capabilities/default.json` も対象に含まれる
- ネイティブバイナリでの実機確認（トレイクリック・ショートカット押下・通知
  表示）は `cargo check` の範囲外のため未実施。`tauri dev` での実機確認は
  ユーザー側で行ってほしい

## 次の増分（今回はやらない）

1. **`gh` プロバイダ**: docs/github-integration.md 相当の GitHub 連携を
   デスクトップ側にも
2. **実リマインダーのフロント連携**: トレイ/ショートカット/通知の土台は
   増分2aで実装済み。予定リマインダーをネイティブ通知に配線するには
   フロント(リモート URL の web アプリ)から Tauri コマンドを呼ぶ仕組みが
   必要（「残 TODO」セクション参照）
3. フロントエンド同梱（オフラインバイナリ）化は CORS + 認証方式の見直しが
   要るため、当面は今回のリモート URL 方式のまま運用する

## Mac 配布: Homebrew cask + 署名回避（2026-07-21 ユーザー決定）

- **配布は Homebrew cask（自前 tap）**。Apple の署名・公証（Developer Program 有料 + notarization）は**行わない**（無料運用）。
- 未署名の Tauri バイナリ（.dmg or .app.tar.gz 等）を **GitHub Releases** に置き、cask の `url`/`sha256` でそれを取得する。
- **署名回避 / Gatekeeper（quarantine）の具体手順は、ユーザーの既存リポジトリ `labolabo` / `harushion` の cask 実装に倣う**（Homebrew tap の cask .rb を参照して同じ形にする）。実装時（Tauri 増分2）に GitHub でそれらの cask を確認してから書く。ここに憶測の手順は書かない。
- CI: リリースビルド（`tauri build`）→ GitHub Releases へ添付 → tap の cask を更新、という流れを想定（`voidzero-dev/setup-vp` とは別。Rust ビルドが要るので macOS runner）。
- 参考: この方式は「署名しない代わりに Homebrew 経由でインストールさせる」もので、ダウンロード直開きの `"開発元を確認できません"` を回避する狙い。正確な回避方法は上記2リポジトリで確認する。
