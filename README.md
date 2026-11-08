<img src="brand/mark-week.svg" width="140" alt="kichijitsu">

# kichijitsu

Notion Calendar 相当の、ローカルファーストなカレンダークライアント。

## 構成

- `apps/web`: Web アプリ(React + Vite)と、配信用の Worker
- `apps/sync`: 同期・認証・MCP の Worker(Cloudflare D1 / Durable Object)
- `apps/site`: ホームページとドキュメント
- `apps/desktop`: デスクトップ版(Tauri。macOS・Windows)
- `apps/mobile`: iOS アプリ(Expo / React Native)と Apple Watch
- `packages/shared`: 共有の型とロジック

詳しくは `docs/` を参照(`docs/desktop.md`、`docs/mobile.md`、`docs/deploy.md` ほか)。

## 開発方法

### 推奨: mise + pnpm

```sh
mise install
pnpm install
pnpm dev
```

### 代替: Docker

再現可能な環境で動かしたい場合はこちら。

```sh
docker compose up
```

http://localhost:5173 で開発サーバーに接続できます。ソースは bind mount 経由でコンテナに渡すため、HMR の体感速度はネイティブ実行より落ちます。
