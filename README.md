<img src="brand/mark-week.svg" width="140" alt="kichijitsu">

# kichijitsu

Notion Calendar 相当の、ローカルファーストなカレンダークライアント。

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
