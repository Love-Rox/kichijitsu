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

## 増分2b: gh プロバイダ（薄い実証 = 作業キューのみ、2026-07-21）

認証が取りづらい org 対策として、Tauri デスクトップ実行時だけ手元の `gh` CLI
認証で GitHub データを取れるようにした（ブラウザ/PWA は従来どおり Worker
OAuth 経由、docs/github-integration.md「認証プロバイダの抽象化」）。

- `src-tauri/src/lib.rs` に `#[tauri::command] gh_api(endpoint: String)` を
  追加。`std::process::Command::new("gh").arg("api").arg(&endpoint)` の
  **非シェル実行**（シェル (`sh -c`) を介さないため endpoint に何が来ても
  シェルインジェクションは起きない）
- `tauri.conf.json` に `app.withGlobalTauri=true` を設定し、webview に
  `window.__TAURI__` を注入。リモート URL 方式（増分1）は不変のまま、
  web 側が `invoke('gh_api', …)` を呼べるようにするだけ
- web 側 `apps/web/src/sync/githubProvider.ts` に `isTauri()`（
  `window.__TAURI__` の有無で判定）、`fetchWorkQueueViaGh()`（作業キューの
  3 search クエリを `gh api` で叩く）、`mapGhSearchToWorkItems()`（gh の
  search レスポンス → `GitHubWorkItemDTO[]` への純関数マッピング、sync 側
  `core/github-queue.ts` 相当のロジックを web 側に再実装）を追加
- `App.tsx` の作業キュー取得 (`fetchGithubQueue`) を `isTauri()` で分岐。
  ブラウザ/PWA では `isTauri()` が常に false になるため、既存の
  `checkedFetch('/api/github/queue')` 経路は無変更で残る（早期 return で
  以降のコードに到達しない設計）

この時点では items/activity/ci/pr-commits は未対応（下記増分2cで対応）。

## 増分2c: gh プロバイダのセキュリティ硬化 + items/activity/ci/pr-commits 拡張（2026-07-21）

### (A) セキュリティ硬化: `gh_api` へのエンドポイント・アローリスト

**背景**: このデスクトップアプリの webview はローカルファイルではなく
**リモート URL** (`https://kichijitsu.love-rox.cc`) を読む（増分1参照）。
増分2b時点の `gh_api(endpoint)` はエンドポイント文字列を検証せずそのまま
`gh api <endpoint>` に渡していたため、そのリモートサイトに何らかの XSS が
刺さると `window.__TAURI__` 経由で `invoke('gh_api', { endpoint })` を
**任意の endpoint** で呼べてしまい、手元の `gh` CLI 認証を使って任意の
GitHub REST エンドポイント（プライベート repo の内容など）を読めてしまう —
攻撃対象領域の拡大になる、というバックグラウンドのセキュリティレビュー
指摘への対応。

`gh api` はデフォルトが GET のためこのコマンド単体に書き込みの実害は薄いが、
「web 側が今使っている形だけを許可し、それ以外は理由を問わず拒否する」設計
にすることで攻撃対象領域をアプリが実際に必要とする範囲に絞った:

- `src-tauri/src/lib.rs` に純粋関数 `is_allowed_gh_endpoint(endpoint: &str)
-> bool` を追加し、`gh_api` はプロセス起動前にこれを通す。拒否時は
  `Command::new("gh")` を一切呼ばずに `Err` を返す
- 許可する9形状のみ（`endpoint` を `?` の前後で path/query に分けて判定、
  余分なパスセグメントは不可）:
  `search/issues`（query は省略可、あれば `q=` 始まりのみ）、`user/repos`、
  `user`（query 無し、login 解決用）、
  `repos/{owner}/{repo}/milestones`、`.../issues`、`.../releases`、
  `.../commits`、`.../actions/runs`、`.../pulls/{number}/commits`
  （いずれも query 任意）。`{owner}`/`{repo}` は `[A-Za-z0-9._-]`、
  `{number}` は数字のみに制限
- 追加の防御: **先頭が `-` の endpoint は拒否**（`gh` の clap ベース引数
  パーサがオプション/フラグとして解釈しうる flag-injection 対策。例:
  `--hostname=evil.example.com`）。**制御文字（`\r`/`\n` 等）を含む
  endpoint も拒否**（`gh` が path+query から HTTP リクエストを組み立てる
  際のヘッダ/行インジェクション対策）
- `#[cfg(test)] mod tests` に `#[test]` 15件（許可9形状それぞれ・不正文字の
  owner/repo・非数字の number・先頭 `-`・制御文字混入・9形状外の
  エンドポイント・`search/issues` の非 `q=` クエリ、をそれぞれ受理/拒否
  で検証）。`cargo check`/`cargo test` とも通過確認済み

### (B) gh プロバイダの拡張: items / activity / ci / pr-commits

増分2bで作業キューのみだった gh 化を、GitHub ペインが使う残り4本
（`GET /api/github/items|activity|ci`、`POST /api/github/pr-commits` の
gh 版）に広げた。返す DTO は Worker 版と完全に同一（`GitHubItemDTO` /
`GitHubActivityDTO` / `GitHubCiRunDTO` / commit タイムスタンプ配列）なので
UI・ストアは無変更で差し替わる。`apps/web/src/sync/githubProvider.ts` に
sync 側 `core/github-items.ts` 等と同じマッピング仕様の**純関数**
（`mapGhRepoItemsToDTO` / `mapGhCommitsToActivity` / `mapGhWorkflowRunsToCi`
/ `mapGhPullCommitsToTimestamps`）+ それぞれの薄い非同期オーケストレーター
（`fetchGitHubItemsViaGh` / `fetchGitHubActivityViaGh` /
`fetchGitHubCiRunsViaGh` / `fetchPullCommitsViaGh`）を追加し、`App.tsx` の
対応する4つの effect を `isTauri()` で分岐（作業キューの
`fetchGithubQueue` と同じ「早期 return でブラウザ/PWA の既存コードには
到達しない」設計。ブラウザ側の挙動・コードパスは無変更）。

gh 版と Worker 版で構造的に異なる点（`gh` CLI には GitHub App の
installation という概念が無いため）:

- **リポジトリ範囲**: Worker 版は GitHub App のインストール先
  (`listInstallationRepos`) に限定するが、gh 版は `GET /user/repos` で
  認証ユーザーが見えるリポジトリを列挙する (`discoverRepos`)。安全上限
  **50件**で打ち切り、上限ちょうどに達したら「本当はもっとあるかもしれない」
  ことを `console.warn` する（2回目の呼び出し無しに真の総数は分からない
  ため）。リポジトリ選択 UI は無く、見える範囲を丸ごと対象にする
- **ページング**: Worker 版は GitHub の `Link: rel="next"` ヘッダーを辿るが、
  `gh_api` (Tauri コマンド) は stdout の JSON 文字列しか返さずレスポンス
  ヘッダーは見えない。代わりに `page=N` クエリを自前で足しながら `gh_api`
  を複数回呼ぶ `paginateGhApi` ヘルパーを実装（`--paginate` は使わない —
  `gh_api` は endpoint 1引数のみでフラグを取れない設計のため）。ページの
  件数が `per_page` 未満になったら打ち切り、Worker 側の各種
  `MAX_*_PER_REPO` 相当の安全上限（milestones/issues 200件・releases
  100件・commits 300件・workflow runs 200件・PR commits 250件、精神は
  同じだが厳密な数値一致は求めない）を超えたら切り捨てて `console.warn`
- **login 解決**: Worker 版は OAuth トークンの持ち主が自明だが、gh 版は
  `gh api user` を1回叩いて `.login` を取り出す (`resolveGhLogin`,
  activity と pr-commits で共用)
- Projects v2 (GraphQL) の date フィールドは Worker 版・gh 版とも対象外
  のまま（次フェーズ、既存 TODO）

テスト: `apps/web/src/sync/githubProvider.test.ts` に新設4関数ぶんの
純関数テストを追加（milestone→issue の due_on 継承、`pull_request` 有無
での issue/pr 判定、release の draft/published_at フィルタと
name→tag_name フォールバック、commit message 先頭行のみ採用、
author.date→committer.date フォールバック、workflow_runs 配列アンラップ、
PR commit の author.login 絞り込み・null 除外・昇順ソート、など）。
`pnpm --filter web test` は 403→419（+16）。

### 検証した範囲

- `cargo check`（`apps/desktop/src-tauri/` 配下）成功、警告無し
- `cargo test` 15/15 成功（アローリストの許可/拒否ケース網羅）
- `pnpm --filter web test` 419/419 成功
- `pnpm --filter web run typecheck` / `pnpm --filter sync run typecheck`
  とも 0（`apps/sync` は無変更）
- `pnpm --filter web run build` 成功
- `pnpm exec vp fmt --check`（リポジトリ全体 281 ファイル）整形済みを確認

### 残 TODO

1. **Projects v2 (GraphQL) の date フィールド**: Worker 版・gh 版とも
   対象外のまま（既存 TODO、フェーズ④以降で検討）
2. **repo 選択 UI**: gh 版は `GET /user/repos`（安全上限50件）で見える
   リポジトリを丸ごと対象にする。ユーザーが対象リポジトリを絞り込める
   設定 UI は無い
3. **未ログイン導線 UI**: `gh` CLI が未インストール/未ログインの場合、
   各 `fetchXViaGh()` は例外を投げて `console.warn` した上で空データに
   フォールバックするのみ。OAuth 連携（ブラウザ/PWA 側）のような
   「連携してください」の案内 UI は無い

## 次の増分（今回はやらない）

1. **実リマインダーのフロント連携**: トレイ/ショートカット/通知の土台は
   増分2aで実装済み。予定リマインダーをネイティブ通知に配線するには
   フロント(リモート URL の web アプリ)から Tauri コマンドを呼ぶ仕組みが
   必要（「残 TODO」セクション参照）
2. フロントエンド同梱（オフラインバイナリ）化は CORS + 認証方式の見直しが
   要るため、当面は今回のリモート URL 方式のまま運用する

## Mac 配布: Homebrew cask + 署名回避（2026-07-21 ユーザー決定）

- **配布は Homebrew cask（自前 tap）**。Apple の署名・公証（Developer Program 有料 + notarization）は**行わない**（無料運用）。
- 未署名の Tauri バイナリ（.dmg or .app.tar.gz 等）を **GitHub Releases** に置き、cask の `url`/`sha256` でそれを取得する。
- **署名回避 / Gatekeeper（quarantine）の具体手順は、ユーザーの既存リポジトリ `labolabo` / `harushion` の cask 実装に倣う**（Homebrew tap の cask .rb を参照して同じ形にする）。実装時（Tauri 増分2）に GitHub でそれらの cask を確認してから書く。ここに憶測の手順は書かない。
- CI: リリースビルド（`tauri build`）→ GitHub Releases へ添付 → tap の cask を更新、という流れを想定（`voidzero-dev/setup-vp` とは別。Rust ビルドが要るので macOS runner）。
- 参考: この方式は「署名しない代わりに Homebrew 経由でインストールさせる」もので、ダウンロード直開きの `"開発元を確認できません"` を回避する狙い。正確な回避方法は上記2リポジトリで確認する。

### リリース CI・cask ファイル（増分3、2026-07-21）

`Love-Rox/Harushion` の `.github/workflows/release.yml` と
`Love-Rox/homebrew-tap` の `Casks/harushion.rb`（`gh api` で実物を取得して確認
済み）に倣い、以下を用意した。**実際のタグ push・tap への配置はユーザーが行う
（この増分ではファイルの整備のみ）。**

- `.github/workflows/release.yml`（リポジトリ root）
  - `on: push: tags: ["v*"]`、`permissions: contents: write`
  - `runs-on: macos-latest` のみ（Mac 配布が要件のため。Win/Linux は今回含め
    ない）。`args: --target universal-apple-darwin` で universal バイナリを
    ビルド
  - kichijitsu は pnpm workspace（Harushion は npm）なので、Harushion 版から
    差し替え: `pnpm/action-setup@v4`（`package.json` の `packageManager` を
    自動検出）→ `actions/setup-node@v4`（`node-version: 26`、mise.toml に
    合わせる、`cache: pnpm`）→ `pnpm install --frozen-lockfile`
  - `dtolnay/rust-toolchain@stable`（`targets:
    aarch64-apple-darwin,x86_64-apple-darwin`）、`swatinem/rust-cache@v2`
    （`workspaces: apps/desktop/src-tauri`）
  - `tauri-apps/tauri-action@v0`: `projectPath: apps/desktop`（`src-tauri` の
    親。Harushion は `src-tauri` がリポジトリ直下なので `projectPath` 省略、
    kichijitsu は monorepo なので明示が必要）、`tagName: ${{
    github.ref_name }}`、`releaseName: "kichijitsu ${{ github.ref_name
    }}"`、`releaseBody` に Homebrew インストール手順・`xattr` 案内・`gh auth
    login` 案内を記載
  - **フロントエンドビルド不要**（増分1のリモート URL 方式のまま。
    `frontendDist` はリモート URL なので `beforeBuildCommand` 等は追加してい
    ない）
  - **Apple 署名 secret は要求しない**（証明書・公証まわりの env は無し）。
    Harushion にあった `TAURI_SIGNING_PRIVATE_KEY` 系も、kichijitsu には
    updater プラグインが無いため含めていない
  - **cask 自動更新 job は入れていない**（tap 更新用の PAT secret
    (`HOMEBREW_TAP_TOKEN` 等) が無い前提のため。下記「リリース/配布手順」で
    手動更新する）
- `apps/desktop/homebrew/kichijitsu.rb`（cask のソースオブトゥルース。tap
  本体ではなくこのリポジトリ内に置く）
  - `harushion.rb` を kichijitsu 用に置き換え: `version "0.1.0"`、`sha256`
    は**プレースホルダ**（初回リリース後に実 DMG の `shasum -a 256` へ差し替
    える旨をファイル内コメントに明記。`:no_check` にはしていない —
    改ざん検知のため実ハッシュ運用を維持する方針）
  - `url` は
    `https://github.com/Love-Rox/kichijitsu/releases/download/v#{version}/kichijitsu_#{version}_universal.dmg`
    （`productName` が `kichijitsu`、tauri-action のデフォルト命名規則で
    DMG 名が `kichijitsu_0.1.0_universal.dmg` になる想定）
  - `name`/`desc`/`homepage`/`livecheck (github_latest)`/`depends_on macos:
    :ventura`/`app "kichijitsu.app"`/`caveats`（`xattr -rd
    com.apple.quarantine` ＋ システム設定フォールバック ＋ `gh auth login`
    案内）は harushion.rb と同じ形

### リリース/配布手順（実際にタグを切るときにユーザーが行う）

1. バージョンを上げる: `apps/desktop/src-tauri/tauri.conf.json` の
   `version` と `apps/desktop/package.json` の `version` を揃えて更新（この
   増分時点では両方 `0.1.0` で揃っている）
2. タグを push する:
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. GitHub Actions（`.github/workflows/release.yml`）が macOS universal の
   DMG をビルドし、GitHub Release を自動作成する（`draft` になるので内容を
   確認してから公開する。tauri-action のデフォルト挙動）
4. 公開された Release の DMG をダウンロードし、sha256 を取得する:
   ```sh
   shasum -a 256 kichijitsu_0.1.0_universal.dmg
   ```
5. `Love-Rox/homebrew-tap` リポジトリの `Casks/kichijitsu.rb` を、
   `apps/desktop/homebrew/kichijitsu.rb` の内容 ＋ 手順4で得た実 sha256 で
   新規作成（初回）または更新する（`harushion.rb`/`labolabo` と同じ tap に
   同居させる）
6. 動作確認:
   ```sh
   brew install --cask love-rox/tap/kichijitsu
   ```
   無署名配布のため、初回起動が Gatekeeper にブロックされたら:
   ```sh
   xattr -rd com.apple.quarantine /Applications/kichijitsu.app
   ```
   （tap のインストール自体に GitHub CLI 認証が要る場合は `brew install gh
   && gh auth login` を先に行う）
7. 以降のバージョンアップも 1〜6 を繰り返す（cask 自動更新 job は無いため、
   tap 側の更新は毎回手動）
