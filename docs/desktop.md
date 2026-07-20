# デスクトップアプリ (Tauri 2)

`apps/desktop` は Tauri 2 製の kichijitsu デスクトップシェル。方針は
docs/multiplatform.md の「Tauri 2 デスクトップ: まずリモート URL 方式」に従う
（2026-07-21 増分1で追加）。

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
    Cargo.toml            # tauri 2 依存のみ（コマンド無しなので serde 等も無し）
    build.rs
    src/
      main.rs
      lib.rs              # tauri::Builder::default().run(...) のみ
    capabilities/
      default.json        # core:default のみ
    icons/                # tauri icon で生成した icns/ico/png 一式
```

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

## 次の増分（今回はやらない）

1. **`gh` プロバイダ**: docs/github-integration.md 相当の GitHub 連携を
   デスクトップ側にも
2. **トレイ常駐**: `tauri-plugin-*` ではなく `tray-icon` 機能でメニューバー
   常駐・ウィンドウの開閉
3. **グローバルショートカット**: `tauri-plugin-global-shortcut` でクイック
   入力などを呼び出す
4. **ネイティブ通知**: `tauri-plugin-notification` に差し替え（現状 Web
   版は VAPID の Web Push。docs/multiplatform.md の「通知」セクション参照）
5. フロントエンド同梱（オフラインバイナリ）化は CORS + 認証方式の見直しが
   要るため、当面は今回のリモート URL 方式のまま運用する
