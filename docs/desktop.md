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
- **ネイティブ通知**（`tauri-plugin-notification` 2.x）。増分2a では起動時の
  テスト通知だけだったが、**2026-07-30 に予定リマインダーを配線済み**
  （`notify` コマンド + web 側の `sync/reminderSchedule.ts` /
  `hooks/useEventReminders.ts`）。起動時のテスト通知は毎回のノイズになるので
  削除し、代わりに設定画面に「テスト通知を送る」ボタンを置いた
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

### 予定リマインダー（2026-07-30 に配線、2026-07-31 に Google の設定を尊重）

**判定は web 側、Rust は文言を受けて通知を出すだけ**。Rust 側でスケジュールするには
予定データを Rust に持たせる必要があり、Google 同期と繰り返し展開の複製になるため
採らなかった。

- **ウィンドウを閉じても通知は届く**。`CloseRequested` が `prevent_close` + `hide` で
  プロセスは生きているため。届かないのはトレイの「終了」で落としている間だけ
- **予定ごとの `setTimeout` ではなく 30 秒 tick**。同期のたびに occurrence 行は丸ごと
  書き換わる（`reexpandCurrentWindow`）のでタイマーは張り直しが必要になるうえ、
  隠れた webview のタイマーは間引かれ、スリープ復帰でずれる。毎 tick 壁時計から
  判定し直せば tick が遅れても判定は正しい
- **既定は Google の予定ごとのリマインダー設定に従う**（2026-07-31）。設定
  (`ReminderMode`) は「Google の設定に従う（既定）/ 通知しない / 一律◯分前」の3種。
  一律モードは旧来の挙動をそのまま選べるように残してある
  - 解決は `resolveLeadMinutes`（純関数）。`{ minutes: [...] }` はその予定の popup
    リマインダー、`{ useDefault: true }` はカレンダー既定
    （`CalendarListEntryDTO.defaultReminderMinutes`）、未同期（`undefined`）は
    カレンダー既定と同じ扱い（世代7バックフィル中に通知が全部止まるのを避けるため）
  - **`email` は同期していない**。公式に "Email sent by the server" と明記があり
    Google 自身がメールを送るので、同じ時刻にデスクトップ通知を重ねない
    （`derivePopupReminderMinutes` で popup だけに絞る）
  - **1予定に複数のリマインダー**（Google の上限は5件）は**全部出す**
  - **上限 1440 分（1日）**。Google の仕様上の上限は 40320 分（4週間）だが、
    アプリ起動中しか判定できない方式で数日前の通知は保証できず、代わりに起動時の
    一斉通知だけが増える。超過分は**丸めずに落とす**（設定していない時刻に鳴らさない）
  - カレンダー既定は `events.list` の応答トップレベルにも載るが、採っているのは
    **calendarList 側**（起動のたびに取り直されるので、既定を変えたときの追随が素直）
- **通知済みキーは `${leadMinutes}#${id}@${startMs}`**（localStorage、24時間保持）。
  開始時刻を埋め込むので、予定が動けばキーが変わって新時刻で改めて通知し、同じなら
  二重に通知しない。**分数も含める**のは、1予定に複数リマインダーがあるとき「1時間前を
  出した時点で予定ごと通知済み」になって10分前が永久に出なくなるのを防ぐため。
  分数を**先頭**に置いてあるので復元は従来どおり**最後の `@`** で切れる（calendarId が
  `…@group.calendar.google.com` やメール形式のため）
- 条件は `fireAt <= now`・**`now < startMs`**・**`now - fireAt <= 15分`**。2本目が
  「過去の予定に通知が出る」のを防ぎ、3本目が「長いリマインダーぶんが起動時に
  まとめて飛ぶ」のを防ぐ。3本目は15分以内のリマインダー（旧既定の10分を含む）では
  判定窓のほうが狭く一度も効かない = 既存利用者の見え方が変わらない
- **0分（開始時刻ちょうど）のリマインダー**は、実効リード幅を最低1 tick 取って
  開始直前に出す（`fireAt = startMs` のままでは窓の幅が0で永久に出ない）
- **終日予定は通知しない**（「何分前」の基準時刻が無い）。削除済み・ミラー
  （カレンダーブロックの複製 = 二重通知になる）・欠席・勤務場所も対象外

**通知権限は原理的に判定できない。** `tauri-plugin-notification` 2.3.3 の desktop 実装は
`show()` の結果を捨てて必ず `Ok` を返し、`permission_state()` も `Granted` の
ハードコード。したがって macOS で拒否されていてもアプリ側は知りようがない。
「許可されています」と表示するのは嘘になるので、設定画面に**テスト通知ボタン**を置き、
出なければ OS の設定を見るよう案内する形にした。

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

1. **終日予定のリマインダー**: 「何分前」の基準になる時刻が無いため未対応
   （Google 側も終日予定には「前日◯時」の形で設定する）。対応するには
   `AllDayOccurrence` 側にも `reminders` を持たせ、判定を日付起点に分ける必要がある
2. **アプリ未起動でも届く通知**: 現状はプロセスが動いている間だけ。Rust 側に予定を
   持たせるか Web Push が要る（docs/multiplatform.md「通知」参照）
3. フロントエンド同梱（オフラインバイナリ）化は CORS + 認証方式の見直しが
   要るため、当面は今回のリモート URL 方式のまま運用する

## 署名・公証と自動アップデート（2026-11-06〜、上の「署名回避」方針を置き換え）

下の「Mac 配布」節は 2026-07-21 時点の**無署名運用**の記録。2026-11 に Apple Developer
へ個人で契約し、方針を次のとおり変えた。

- **署名・公証**: Developer ID Application で署名し、Apple の公証を受ける。`release.yml` が
  GitHub secrets(`APPLE_*` 6 件)で行い、ビルド後に stapler / codesign / spctl で実ファイルを
  検証する。公証チケットが付くのは DMG ではなく中の `.app`。
- **自動アップデート**(`src-tauri/src/updater.rs`): 更新するのは**シェルだけ**(画面は Web を
  デプロイすれば全員に届く)。起動 30 秒後と 6 時間おきに確認し、新しい版があれば取得して
  適用し、通知する。再起動は強制せず、トレイ「アップデートを確認」で反映する。確認・適用は
  Rust 側だけで行い、webview から呼べる IPC は作らない(capabilities にも `updater:*` を
  与えない)。
- **更新用の署名鍵**は Apple の証明書とは別物(minisign)。公開鍵は `tauri.conf.json` の
  `plugins.updater.pubkey`、秘密鍵は GitHub secrets の `TAURI_SIGNING_PRIVATE_KEY`
  (パスワードを付けた場合は `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)。**秘密鍵を失うと、
  既存の利用者へ更新を出せなくなる**(新しい鍵のアプリを手動で入れ直してもらうしかない)。
  必ずバックアップを取ること。
- 配信先は `https://github.com/Love-Rox/kichijitsu/releases/latest/download/latest.json`。
  `tauri-action` が `latest.json` を作り、`release.yml` の「Verify updater manifest」が
  `darwin-aarch64` / `darwin-x86_64` の url と signature を確かめる。
- 自動更新を入れる前に配った版(v0.1.11 まで)には更新機能が無い。一度だけ手動で入れ直す。
- **Apple Silicon (aarch64) 専用**(2026-11-06、容量とビルド時間を減らすため universal をやめた)。
  成果物は `kichijitsu_<version>_aarch64.dmg` と `kichijitsu_aarch64.app.tar.gz`。Intel Mac には
  配布しない。tap の cask は `url` を `_aarch64.dmg` に、`depends_on arch: :arm64` を足すこと
  (release.yml の cask 更新は version と sha256 だけを書き換える)。
- Homebrew cask は `auto_updates true`。自動更新と二重にならないよう、`brew upgrade` は
  既定では更新しない(`--greedy` で更新)。

## Mac 配布: Homebrew cask + 署名回避（2026-07-21 ユーザー決定）

- **配布は Homebrew cask（自前 tap）**。Apple の署名・公証（Developer Program 有料 + notarization）は**行わない**（無料運用）。
- 未署名の Tauri バイナリ（.dmg or .app.tar.gz 等）を **GitHub Releases** に置き、cask の `url`/`sha256` でそれを取得する。
- **署名回避 / Gatekeeper（quarantine）の具体手順は、ユーザーの既存リポジトリ `labolabo` / `harushion` の cask 実装に倣う**（Homebrew tap の cask .rb を参照して同じ形にする）。実装時（Tauri 増分2）に GitHub でそれらの cask を確認してから書く。ここに憶測の手順は書かない。
- CI: リリースビルド（`tauri build`）→ GitHub Releases へ添付 → tap の cask を更新、という流れを想定（`voidzero-dev/setup-vp` とは別。Rust ビルドが要るので macOS runner）。
- 参考: この方式は「署名しない代わりに Homebrew 経由でインストールさせる」もので、ダウンロード直開きの `"開発元を確認できません"` を回避する狙い。正確な回避方法は上記2リポジトリで確認する。

### リリース CI・cask ファイル（増分3、2026-07-21）

`Love-Rox/Harushion` の `.github/workflows/release.yml` と
`Love-Rox/homebrew-tap` の `Casks/harushion.rb`（`gh api` で実物を取得して確認
済み）に倣い、以下を用意した。**v0.1.0 は 2026-07-21 にリリース済み**（タグ
push → CI ビルド → DMG 公開 → `Love-Rox/homebrew-tap/Casks/kichijitsu.rb`
配置 → `brew install` 検証まで完了）。

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
  - **`tauriScript: pnpm tauri` が必須**（初回リリースで判明・2026-07-21）。
    monorepo では `projectPath`（apps/desktop）直下にロックファイルが無いため
    tauri-action がパッケージマネージャ検出で npm にフォールバックし、
    `npm run tauri build` を実行 → `package.json` に `tauri` スクリプトが無く
    `Missing script: "tauri"` で失敗する。`tauriScript: pnpm tauri` を指定して
    pnpm に `apps/desktop/node_modules/.bin/tauri` を直接叩かせて解決した
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
    は v0.1.0 リリースで実 DMG の `shasum -a 256`
    （`2f47ff27bd782ab683a251d3e3dea0179ee5a11856022137dbedb66e9b3b4a95`）
    に確定済み（`:no_check` にはしない — 改ざん検知のため実ハッシュ運用を維持）
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
2. タグを push する（**アノテートタグ必須**。この repo は lightweight タグを
   弾き `fatal: no tag message?` になる）:
   ```sh
   git tag -a v0.1.0 -m "kichijitsu v0.1.0"
   git push origin v0.1.0
   ```
   （`release.yml` を修正した場合は、タグ push トリガーが**タグの指すコミット
   の** workflow を使うため、修正コミットにタグを張り直すこと:
   `git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0` の後に再作成）
3. GitHub Actions（`.github/workflows/release.yml`）が macOS universal の
   DMG をビルドし、GitHub Release を自動作成・公開する（`gh run watch <id>`
   で完走を確認できる）
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

## 増分2d: Google 連携を **外部ブラウザ** で行う（2026-08-07）

### 背景（本番で確認した事象）

デスクトップ版から Google 連携しようとすると **`401: disabled_client`** で弾かれる
（2026-08-06 に本番で確認）。ブラウザ版では**同じクライアント ID・同じ URL** で通る
ので原因は環境側で確定していて、Google が「埋め込みブラウザ (embedded user-agent)
からの OAuth」を禁止していることによる。Google Cloud Console のプロジェクト診断にも
「レガシー ブラウザ: アプリは、安全でない可能性のある古いブラウザで実行されています」
という警告が出ていた。

### なぜ「外部ブラウザで開く」だけでは足りないのか

このアプリは本番 URL を webview で読むだけの薄いガワ（増分1）で、セッションは
**その webview の Cookie**。外部ブラウザで OAuth を完了させると `Set-Cookie` は
外部ブラウザ側に付いてしまい、アプリの webview は未ログインのままになる。
そこで**使い捨てチケット**を介して webview 側へセッションを渡す3段構えにした。

### 流れ

```
[アプリ webview]  「Google 連携」クリック（apps/web/src/sync/desktopAuth.ts）
       │  (add モードのみ) POST /auth/desktop/add-intent → 署名付き add_token
       ▼  invoke("open_external_login", { path: "/auth/login?..." })
[Rust]  verifier(32バイト乱数) を自分の中に保持し、challenge=SHA-256(verifier) を
       │  URL に足して OS の既定ブラウザで開く
       ▼
[外部ブラウザ]  /auth/login?...&desktop=1&dc=<challenge> → Google 同意 → /auth/callback
       │  チケットを発行し kichijitsu:// へ橋渡しするページを返す
       ▼
[OS]   kichijitsu://auth?ticket=... をアプリへ配送（tauri-plugin-deep-link）
       ▼
[Rust]  保持していた verifier を添えて webview を
       │  /auth/desktop/exchange?ticket=..&verifier=.. へナビゲートする
       ▼
[Worker] チケットを消費し、**webview の Cookie として** sid を発行して APP_URL へ戻す
```

最後を「webview のナビゲーション」にしているのは、`Set-Cookie` がレスポンスを
受け取った Cookie ジャーにしか入らないため。webview 自身にこの GET を踏ませるのが、
webview の Cookie ジャーへ sid を入れる一番素直な方法。

### チケットの仕様

| 項目 | 内容 |
| --- | --- |
| 保管先 | **D1**（`desktop_auth_tickets`、migrations/0014）。発行も交換も同じ Worker 内で完結し、単回使用は `DELETE` の `meta.changes === 1` で表現できるので Durable Object の直列実行は要らない |
| 生値 | 32 バイト CSPRNG → base64url 43文字。**サーバーはハッシュしか持たない**（mcp_tokens と同じ） |
| 寿命 | 3分（`DESKTOP_TICKET_TTL_MS`）。覆うのは「OAuth 完了 → OS がアプリへ配送 → 交換」だけで、同意画面の待ち時間は手前の state cookie(10分)が持つ |
| 単回使用 | 交換要求が来たら**検証の前に必ず行を DELETE** する。成功/失敗にかかわらず1回で死ぬので、verifier の総当たりもできない |
| 取り違え防止 | PKCE 相当。アプリが持つ verifier の SHA-256 を challenge として行に焼き込み、交換時に照合する。悪意ある `kichijitsu://` リンクを踏まされても、そのアプリの verifier とは一致しないため他人のアカウントでログインしない |

add モードだけは別に **署名付き `add_token`**（10分・HMAC・署名対象に
`kichijitsu-desktop-add` の前置き）を使う。外部ブラウザには webview の sid が無く、
これが無いと「アカウント追加のつもりが新規プロファイル作成」になるため。
前置きを混ぜているのは、鍵と形式が sid と同じなので、そのままでは 30 日有効な
セッションとして通ってしまうから。

### 追加したライブラリ（通常方針の例外）

このリポジトリは「新しいライブラリを追加しない」方針だが、Google 側の制約への対処
としてユーザー承認のうえ以下を追加した（詳細な理由は `src-tauri/Cargo.toml` のコメント）。

- `tauri-plugin-deep-link`: `kichijitsu://` の OS 登録と受信。登録の作法が OS ごとに
  全く違うため自前実装は非現実的
- `tauri-plugin-opener`: 既定ブラウザで URL を開く。**プラグイン登録はせず** Rust の
  自由関数 `open_url` だけ使う（JS 側へ「任意 URL を開く」コマンドを生やさないため）
- `sha2` / `getrandom`: challenge の計算と verifier の生成。ハッシュと CSPRNG の自前実装は避ける
- `serde_json`: 直接は使わない。`tauri.conf.json` に `plugins` セクションを書くと
  `generate_context!` の展開先が要求するため

いずれも既に tauri の依存グラフに推移的に入っており、新しい供給元は増えていない。

### ブラウザ版/PWA は無変更

分岐は既存の `isTauri()`（`window.__TAURI__` の有無）1箇所だけ。ブラウザでは必ず
false になり、`location.href = "/auth/login…"` の**文字列も従来と完全に同一**
（`buildGoogleLoginPath` のテストで固定）。Worker 側も `desktop=1` + `dc` が
そろわない限り従来の分岐をそのまま流れ、state の JSON も1バイトも変わらない。

### 実機確認の注意

- **macOS ではスキーム登録がバンドル済みアプリに対して行われる**ため、`tauri dev`
  ではディープリンクが届かないことがある。`pnpm build:desktop` で作った `.app` から
  確認すること
- Windows/Linux ではディープリンクがアプリの**新しいインスタンス**として起動する
  （プラグインの README）。同じ挙動にそろえるには `tauri-plugin-single-instance` の
  `deep-link` feature が要るが、現状の配布対象は macOS なので今回は入れていない
- 本番へは `apps/sync/migrations/0014_desktop_auth_tickets.sql` の適用が必要

## Notion カレンダー並みにする計画(2026-11-07〜)
デスクトップは本番の Web 版をそのまま読むので、機能追加は Web 版(`apps/web`)への追加になる。
モバイルで足したものと、Notion カレンダーでできることを目安に、次の順で進める(自然文での予定作成は MCP で足りるので外す。予約リンクは作らない)。

1. 予定の色の変更 — **済み**(詳細カードの「色」欄。繰り返しの予定は「この予定のみ/すべての予定」を選ぶ)
2. アクセント色のテーマ — **済み**(設定 →「テーマ」の下に「アクセント色」。モバイルと同じ 6 色)
3. アイコンのフラット化(Phosphor duotone。モバイルと同じ系統) — **済み**(`components/icons.tsx`。Slack・Meet・Zoom・Teams のブランドマークは、そのまま)
4. 会議リンク(Meet)を予定から作る — **既存の予定に追加するところまで済み**(詳細カードの「Google Meet を追加」)。作成時に付ける・モバイルは未着手
5. 複数タイムゾーン — **済み**(設定 →「タイムゾーン」で最大 2 つ。時刻軸の左に並ぶ)
6. デスクトップ固有(メニューバーに次の予定、など)

### 予定の色の変更
- `POST /api/event/color`(モバイルと共通。サーバーは `apps/sync/src/core/event-color.ts`)。ゲストへのメールは出ない。
- Web 版は `hooks/mutations/useEventColor.ts`(サーバーが受け付けてから手元へ反映する「保存ボタン方式」)。繰り返しの予定は、Google のインスタンス ID(`親ID_UTC開始`)へ書き、手元でも、その回の override に色(`color` + `hasCustomColor`)を残す。
- 同期で取り込む例外インスタンスにも、`colorId` から色を入れる(`mapGoogle.ts` の `buildOverride`)。入れないと、この回の色が、次の同期でシリーズの色に戻る。
- 色の候補(11 色と名前)は `layout/eventColorChoices.ts`。モバイルも共有する。
- 繰り返しの予定の色は、Web・モバイルとも、**「この予定のみ/すべての予定」を選べる**(既定は、影響の小さい「この予定のみ」。Google カレンダーと同じ)。「この予定のみ」は、Google のインスタンスに書いて、手元は例外インスタンス(override)に残す。「すべての予定」は、親の予定に書いて、series の色を書き換えて再展開する。その回だけ個別の色を付けた回は、Google と同じく、その色のまま残る。リクエストの宛先は `sync/eventColor.ts` の `buildEventColorRequest(subject, colorId, scope)` が決め、モバイルも Web のこれを使う。

### アクセント色
- 表は `layout/accentPalette.ts`(Web・モバイル共通。モバイルの `lib/accents.ts` はこれを再エクスポートする)。
- `<html data-accent="…">` で、`theme.css` のアクセント系トークンを差し替える。CSS は `node brand/gen-web-accents.mjs` が表から作る(`src/theme-accents.css`、手で直さない)。既定の朱は属性なし。ライト/ダークは `light-dark()`、半透明用の `--c-accent-rgb` だけは `theme.css` と同じ 3 か所に分けて書く。
- 濃い字(`--c-accent-ink`)と縁(`--c-accent-soft-line`)は、朱の値から逆算した割合で自動で作る。色を足すときは、コントラストを目で確かめること。
- 保存は localStorage(`kichijitsu:accent`)。初回描画前の適用は `app/index.html` のインラインスクリプト(許す名前を手で書いてある。`ACCENT_KEYS` を変えたら直す)。ログアウトでは消さない(テーマ設定と同じ扱い)。

### アイコン
- `components/icons.tsx` の UI アイコン 12 個(ピン・パネル・カレンダー・歯車・横三点・タイマー・タグ・検索・拡大/縮小・ビデオ・場所)を、Phosphor duotone(MIT)に差し替えた。形のデータは `components/iconPaths.ts`(生成物。`node brand/gen-web-icons.mjs`。手順はスクリプトの先頭)。コンポーネント名と props は変えていないので、呼び出し側は無変更。
- 色は `fill="currentColor"` で親の `color` に従う(薄い面は不透明度 0.2 の層)。

### Meet の追加
- サーバー: `POST /api/event/meet`(`core/event-meet.ts`・`google/event-meet.ts`)。`events.patch` に `conferenceData.createRequest`(`hangoutsMeet`)を送る。**`conferenceDataVersion=1` が無いと、Google は黙って何もしない**ので必ず付ける。`requestId`(冪等キー)は 401 の再送でも同じ値を使い、会議が二重に作られないようにする。会議の作成が失敗(200 + `status: failure`)のときは、エラーにする。ゲストへの通知は、時刻・タイトルの変更と同じ既定(外部ゲストにだけ。`DEFAULT_SEND_UPDATES`)。
- Web: `hooks/mutations/useEventMeet.ts`(サーバーが URL を返してから、手元の予定にリンクを書く「保存ボタン方式」)。繰り返しの予定は、シリーズ全体に付く(手元で先に更新するのは、操作した回だけ。ほかの回は次の同期で入る)。URL が返らなかった(Google がまだ作っている途中)ときは、次の同期でリンクが入る。
- 出す条件(`sync/eventMeet.ts` の `canAddMeet`): 編集できる Google の予定で、まだ会議が無く、不在・勤務場所・ミラーでないもの。終日の予定には出さない。
- 未着手: 予定の作成フォームで「Meet を付ける」(作成 → すぐ追加、で足せる)、モバイルのボタン。

### 複数タイムゾーン
- 設定 →「タイムゾーン」で、別のタイムゾーンを最大 2 つ追加する。週・日表示の時刻軸の左に、近い順に、その時刻が並ぶ(右端が基準 = 端末のタイムゾーン)。各列の見出しは、都市名と UTC からのずれ(`GMT-5`、`GMT+5:30`)。予定の時刻は、これまでどおり、端末のタイムゾーンで表示する(月表示には出ない)。
- ロジックは `layout/secondaryTimeZones.ts`(検証・正規化・各時刻のラベル。夏時間の日も、基準の側の壁時計を起点にするので、基準の軸の各行と必ず対応する)。保存は `sync/secondaryTimeZonesPref.ts`(localStorage `kichijitsu:secondaryTimeZones`。`useSyncExternalStore`で、変えるとすぐ反映)。ログアウトでは消さない(テストの設定と同じ扱い)。
- 時刻軸(ガター)の幅は、CSS 変数にまとめた: `--gutter-total` = `--gutter-base`(60px、スマホ 40px)+ `--tz-count` × `--tz-col-w`(54px、スマホ 52px)。終日・タスク・GitHub などの各レーンのガターも、同じ幅を使い、日の列が全レーンで縦にそろう。
- ラベルは、いま見えている範囲の最初の日を基準に作る(週の途中で夏時間が切り替わると、それ以降の日は 1 時間ずれる。Notion カレンダーも、軸は 1 本)。

## 見渡しやすさ(スケジュール画面の見直し、2026-11-07〜)
画面の現状(ダミーデータ `?demo=1`、開発サーバーのみ)を見て、課題を挙げ、小さな PR で直している。

### A. 週表示(済み)
- **重なった予定**: 横に並べるレーンは 3 本まで(スマホ幅は 2 本)。超える分は隠して、その塊の右端に「+N」のチップを出す。押すと、その塊だけ上限なしで全部開き、チップは「畳む」になる。ロジックは `layout/overlapLayout.ts` の `layoutOverlapsCapped`(既存の `layoutOverlaps` は挙動を変えず、モバイルも従来どおり)。隠した予定がある塊は、右端 16%(`CHIP_RESERVE_FRAC`)をチップのために空ける。
- **曜日の見分け**: 日付の数字を大きく(13→16px)、土日と今日より前の日は、列の地をごく薄く色づけ、見出しを淡くする。今日の列は従来どおり。
- **不在・勤務場所の帯**: 普段は薄く(不在 0.88→0.5、勤務場所 0.68→0.4)。ホバー/フォーカスで濃くなる。終日レーン側の不在バーは変えていない。
- 上の帯(ツールバー・日付・終日・タスク)は、内容が無い行は元から隠れるので、今回は触っていない。

### B. 月表示(済み)
- 時刻付きの通常の予定は、**色の点 + 時刻 + タイトル**の軽い表示(背景・左の棒なし)。終日・不在・勤務場所は、箱/帯のまま(「その日の枠」を示すので、強さを残す)。返事が未定の予定は、点を輪郭だけにする。
- 日付の数字を大きく(11→13px)、土日の列をごく薄く色づける。今日のバッジも少し大きく(16→20px)。
- **スマホ幅**: 予定は色の点だけ(横に折り返す)、終日などは細い帯。文字は 1 文字ほどしか読めなかったため。予定のタップはマスへ通り、その日に移る(詳細は、移った先で開く)。1 マスに載せる数は、箱のときの 3 倍(`MonthView.tsx` の `rowCapacity`)。

### 次
- 長い予定のタイトルを、スクロールしても、見えている範囲の最上部に残す(スマホ幅、月表示以外)

## 長い予定のタイトルを、最上部に残す(スマホ幅、月表示以外。2026-11-07)
- 長い予定を下へスクロールすると、時刻とタイトルが画面の上に消えて、何の予定か分からなくなる。予定カードの中身(`.event-body`)を `position: sticky; top: 2px` にして、カードの上端がスクロール領域の上に出たら、見えている範囲の最上部に貼り付ける。カードの下端に着いたら、そこで止まる。
- sticky が効くには、カードも、その外側の日列の窓(`.week-grid-days-viewport`)も、「スクロールの枠」になっていてはいけない。どちらも `overflow: hidden` だったので、スマホ幅だけ `overflow: clip`(同じ切り抜きで、枠を作らない)にした。これを忘れると、sticky が、動かない要素を基準にして、効かない。
- カードの中身がカードの高さをほぼ占めるとき(短い予定、場所が何行も入る予定)は、動かせる余地が無く、貼り付かない(元から全部見えているので、問題ない)。
- 当初はスマホ幅だけだったが、デスクトップ幅にも広げた(`@media (max-width: 640px)` の条件を外し、全幅で `overflow: clip` + sticky)。1280px 幅で、カードの上端が 32px 上に出ても、中身が最上部に残ることを確認。

## スマホ幅の整理(2026-11-07)
- **別タイムゾーンの列は 1 つまで**(幅 640px 以下)。設定で複数を選んでいても、基準の隣の 1 つだけを出す。列が増えると、予定の幅が足りなくなるため。設定は変えない(広い画面では、全部出る)。`WeekGrid.tsx`。
- **3日・1日表示は今日から始める**。月表示や週表示から切り替えたとき、月の 1 日や週の月曜から始まり、過去の日しか見えないことがあった。切り替え前に見ていた期間に今日が入っているときは、今日から始める。入っていなければ(過去や未来を見ているとき)、見ていた期間の先頭のまま。`layout/viewRange.ts` の `startOnViewSwitch`。
- ツールバーは、スマホ幅(390px)で、折り返しや欠けがなく収まっていたので、変えていない。

## メニューバーに次の予定(2026-11-07)
- トレイのアイコンの横に、次の予定を文字で出す(macOS)。「10:30 定例」、1 時間以内は「定例 あと15分」、進行中は「定例 進行中」。マウスを載せると、長い説明が出る。Windows/Linux はタイトルを出せないので、説明だけ。
- 分担はリマインダー通知と同じ: **判定と文言は web**(`sync/trayNextEvent.ts` の純関数、`hooks/useTrayNextEvent.ts` が 30 秒ごとに store を読み直し、文言が変わったときだけ送る)。**Rust は渡された文言をトレイに出すだけ**(`set_tray_info`、トレイの ID は `main`、40 文字に切り詰め)。予定のデータは Rust に無い。
- 対象は、終わっていない予定のうち開始が最も早いもの(先の 12 時間まで)。不在・勤務場所・ミラー・辞退は除く。終日の予定は出さない(時刻が無いため)。
- 設定モーダルの「メニューバーに次の予定を出す」でオフにできる(既定はオン)。オフにすると、次の 30 秒以内に消える。
- リモート URL 方式なので、web は本番反映で届くが、**`set_tray_info` の入口は Rust 側の変更**。新しいデスクトップのビルド(署名リリース)を入れるまでは、旧版では invoke が失敗して、何も出ない(エラーは握りつぶして、console に出すだけ)。

## 作成時の Meet と、モバイルの Meet ボタン(2026-11-07)
- **作成フォームに「Google Meet の会議を追加」**(Web は詳細フォームのチェックボックス、モバイルはスイッチ)。作成の API には会議の指定が無いので、**予定を作って確定 id が分かってから、既存の予定への追加(`/api/event/meet`)を続けて呼ぶ**。サーバーは変えていない。不在では出さない。
- 追加が失敗しても、予定は消さない(もうできているため)。Web は保存エラーの表示、モバイルは「予定は作成しました。Meet は付けられませんでした」のアラートで知らせ、詳細から付け直せる。
- **モバイルの詳細シートに「Google Meet を追加」ボタン**(Web と同じ `canAddMeet` の条件。会議が無い、編集できる Google の予定だけ)。繰り返しはシリーズ全体に付く。Google がリンクを返さなかったときは、同期でリンクが入る旨を知らせる。

## Web をモバイル版の雰囲気に寄せる(2026-11-07)
- 配色は、もともとモバイルが Web のパレットを写したものなので同じ。違っていたのは、**形と密度**だった。寄せたのは、ツールバーとボタン / 文字の大きさと余白 / 予定の詳細カードと作成・編集フォーム(予定カードそのものの見た目は、今回は変えていない)。全画面幅に適用。
- 変更は **`apps/web/src/mobile-look.css` に集約**(`App.tsx` で `App.css` のあとに読み込み、同じ詳細度で上書き)。各コンポーネントの CSS は触っていない。**戻すときは、この import を外すだけ**。
- ボタン: 枠線をやめて、押せる所だけ、薄い地(`--c-surface-2`)で示す。ペインが開いている間は、朱の枠でなく、薄い朱の地+朱の文字。週/月、返信(参加/未定/不参加)、色の適用範囲、時間軸のズームは、薄い地に載せた「つまみ」(選択中だけ朱で塗る)。
- 文字: 11〜13px だった所を、14〜16px へ(詳細カードのタイトルは 18px)。ツールバーの高さは 48→56px、角丸は 6→8〜14px。詳細カードは 280→340px 幅(`eventPopoverShared.ts` の配置計算の定数も合わせた)。編集・削除の文字ボタンは、下線をやめて朱の文字(モバイルと同じ)。
- スマホ幅(640px 以下)は、横が足りないので、ツールバーのボタンの余白だけ詰める。
- **予定カード**: モバイルのカードは、左の棒+カレンダー色の薄い地だけで、影が無い。Web は同じ作りに段差の影が付いていたので、影を外した(カーソルを載せたときだけ、軽く浮かせる)。文字は 12px のまま ―― 13px にすると、短いカードで文字が切れる所が増えた。

## 次の会議に参加・予定を作るショートカット・トレイの予定一覧・自動起動(2026-11-07)
メニューバーの次の予定(上の節)に続けて、Notion カレンダーのデスクトップ版にある 4 つを足した。分担は同じ: **判定は web**(`sync/trayNextEvent.ts` の純関数)、**Rust は渡されたものを出す/動かすだけ**。

- **トレイのメニュー**(右クリック): 上から「会議に参加: 10:30 定例」(次の会議があるときだけ)/ 今日のこれからの予定(最大 8 件、押すと、ウィンドウを前面に出して、その予定の日へ移る)/ 区切り / 表示・再読み込み・アップデート・終了。web が 30 秒ごとに `set_tray_info` へ内容を渡し、Rust がメニューを作り直す(`build_tray_menu`)。左クリックは、これまでどおり、ウィンドウの表示/隠す。
- **次の会議に参加**: 「次の会議」は、終わっていない予定のうち、開始が最も早く、ビデオ会議の URL(Meet・Zoom・Teams など。場所に入っている会議 URL も含む)を持つもの(進行中も含む。`pickNextMeeting`)。トレイのメニュー、または **Cmd+Option+J**(`JOIN_MEETING_SHORTCUT`)で、既定のブラウザで開く。**URL は、web から Rust へ渡して、Rust が持つ**(http/https のみ、2000 文字まで。`validate_join_url`)。web から「この URL を開け」と直接頼む口は作らない ―― 開くのは、メニュー/ショートカットを押したときだけ(`open_external_login` と同じ脅威モデル)。
- **予定を作るショートカット**: **Cmd+Option+N**(`QUICK_CREATE_SHORTCUT`)で、ウィンドウを前面に出して、作成フォームを開く(web の `n` キーと同じ処理 `handleNewEventShortcut`)。Rust は、window に `kichijitsu-desktop` という CustomEvent を送り(`dispatch_web_event`、中身は定数と整数だけ)、web の `hooks/useDesktopEvents.ts` が受ける(形を確かめてから使う)。Cmd+Shift の組み合わせは Finder などの「新規」と衝突するので、Option を足した。他のアプリと衝突して登録できなくても、起動は止めない(ログに出すだけ)。
- **ログイン時に自動起動**(macOS): `~/Library/LaunchAgents/cc.love-rox.kichijitsu.autostart.plist` を置く/消す(`get_autostart` / `set_autostart`)。新しいライブラリは足さず、plist を直接書く(`autostart_plist`、中身は自分の実行ファイルの場所だけ)。既定はオフ。設定モーダルの「ログイン時に自動で起動する」から切り替える。macOS 以外は未対応(エラーを返す)。Homebrew で入れた場合は、アプリの場所を変えたら、一度オフ→オンにして、plist を書き直す。
- 新しい Rust のコマンド(`set_tray_info`・`get_autostart`・`set_autostart`)の許可は `capabilities/remote.json`。**新しい署名ビルドを入れるまで、旧版では、これらの invoke が失敗して、何も出ない**(エラーは握りつぶす)。

