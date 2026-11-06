# モバイルアプリ (React Native / Expo)

2026-11-06 に方針を確定。iOS アプリは **React Native (Expo)** で作る。配布は TestFlight。

## なぜ React Native か
- 最初は Tauri 2 の iOS を試したが、Xcode 27 / iOS 27 で WebView が真っ黒になる問題が残った
  (UIScene 宣言・swift-rs・cfg 分離までは解決。`feat/ios-app` ブランチに保留)。
- 別プロジェクト (m-ai-log) で Expo 58 / RN 0.88 が実績あり。ビルドは EAS または手元の Xcode 27 で通る。
- ウィジェット・Live Activity・Watch など、ネイティブ機能を足す余地がある。
- デスクトップも将来 React Native (react-native-macos 等) へ載せ替えてよい、とユーザーの了承あり。

## 構成
- `apps/mobile`: Expo アプリ。ルートの pnpm workspace からは除外した**独立区画**
  (`pnpm-workspace.yaml` で `!apps/mobile`)。Metro の安定のため。
- 共有コード: `metro.config.js` のエイリアス `@kichijitsu/web/...` で `apps/web/src` の
  **純粋なロジック**を直接 import する (予定の変換 `sync/mapGoogle`、繰り返し展開
  `expansion/expandSeries`、重なり配置 `layout/overlapLayout` など)。DOM / IndexedDB /
  localStorage に依存するファイルは import しない。安定したら `packages/core` へ移す。
- `@js-temporal/polyfill` は Web 側とモバイル側で同じ1つを使う (Metro の `resolveRequest`)。
- Hermes で Temporal のタイムゾーン計算 (夏時間の日の長さ・壁時計 → epoch など) が正しく動くことを
  確認済み (`apps/mobile/src/lib/temporalCheck.ts`、`/debug` 画面)。

## ログイン
デスクトップ版と同じ「外部ブラウザ + チケット/verifier の交換」。
1. アプリが verifier を作り、`challenge = SHA-256(verifier)` を付けて
   `/auth/login?desktop=1&dc=<challenge>` を `ASWebAuthenticationSession` で開く。
2. Google の同意 → サーバーがチケットを発行し `kichijitsu://auth?ticket=...` へ戻す。
3. アプリが `POST /auth/mobile/exchange` にチケット + verifier を渡し、セッション値を JSON で受け取る。
4. セッション値は Keychain (SecureStore) に保存し、以後 `Authorization: Bearer` で `/api/*` を呼ぶ。
   値は sid cookie と同じ署名・形式・有効期間 (30 日)。サーバー側の失効管理は cookie と同じく無い。

## 開発
```
cd apps/mobile
pnpm install
npx expo run:ios --device <シミュレータの UDID>   # ネイティブ依存を足したら再ビルド
npx expo start --dev-client                        # metro.config.js を変えたら再起動
```
Xcode 27 ではシミュレータの画面は `DeviceHub.app` (Xcode.app/Contents/Applications) になっている。

## 次にやること
3日表示 → 月表示・日アジェンダ → 手元への保存 (ローカルファースト) → 作成・編集・削除 →
通知・ウィジェット。
