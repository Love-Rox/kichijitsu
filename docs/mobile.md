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

## 手元への保存 (ローカルファースト)
- 保存先は `expo-sqlite` (`apps/mobile/src/lib/localDb.ts`)。Web 版の IndexedDB と同じく、**変換済み**の予定
  (`mapGoogleEvents` の結果: 単発・終日・繰り返しの親・例外インスタンス) を、カレンダーごとに保存する。
  繰り返しの展開結果は保存せず、表示のたびに展開する。
- 差分の適用規則は Web の `applySyncResponse` と同じ(全同期はそのカレンダーだけ入れ替え、差分は
  親の削除 → put → 単発/終日の削除)。全体を1トランザクションにする。
- 同期位置はサーバーが (account, calendar, deviceId) ごとに持つ。`deviceId` は端末で固定の値を meta に保存。
- 起動時: ① 保存済みのデータがあれば即座に表示 → ② サーバーと差分だけ同期し、カレンダーごとに反映。
  通信に失敗しても、保存済みのデータは見られる。
- 計測 (シミュレータ・開発モード): 初回(全件)は約 16 秒、2 回目以降は保存済みを即表示し、差分同期は
  全カレンダーで約 0.3 秒(変更なしのとき)。
- ログアウト/未ログイン応答時は保存した予定とメタ情報をすべて消す。進行中の読み込みは AbortSignal で中止し、
  中止された読み込みは画面にもデータベースにも書かない。

## 開発
```
cd apps/mobile
pnpm install
npx expo run:ios --device <シミュレータの UDID>   # ネイティブ依存を足したら再ビルド
npx expo start --dev-client                        # metro.config.js を変えたら再起動
```
Xcode 27 ではシミュレータの画面は `DeviceHub.app` (Xcode.app/Contents/Applications) になっている。

## TestFlight への配布
手元の Mac (Xcode 27) から、アーカイブ → アップロードする(EAS は使っていない)。
前提: Xcode の Settings → Accounts に Apple ID を追加済み(自動署名が証明書とプロファイルを作る)。
App Store Connect に Bundle ID `cc.love-rox.kichijitsu` の App を作成済み。

```
cd apps/mobile
npx expo prebuild --platform ios --clean          # ios/ を作り直す(.gitignore 済み)
xcodebuild -workspace ios/kichijitsu.xcworkspace -scheme kichijitsu -configuration Release \
  -destination 'generic/platform=iOS' -archivePath /tmp/kichijitsu.xcarchive \
  DEVELOPMENT_TEAM=M296DX39G6 CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath /tmp/kichijitsu.xcarchive \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates      # アップロードまで行う
```
ExportOptions.plist は `method: app-store-connect` / `destination: upload` / `teamID` /
`signingStyle: automatic` / `uploadSymbols: true`。
- **同じ version で再アップロードするときは `ios.buildNumber` を上げる**(app.json。重複は拒否される)。
- dSYM の警告(React.framework など)は、クラッシュ報告の記号化にだけ効く。配布には影響しない。
- アイコンは `node brand/gen-ios-icon.js` で再生成する。
- タイトルのロゴタイプは `brand/wordmark.svg` を使う(`components/Wordmark.tsx`、react-native-svg)。
  `apps/mobile/src/assets/wordmarkSvg.ts` は生成物で、`node brand/gen-mobile-wordmark.js` で再生成する
  (j の点の朱だけをテーマのアクセント色に差し替えられるよう、プレースホルダにしてある)。
- シミュレータのデバッグ構成のビルドが、`facebook::react::Sealable::Sealable()` の未解決でリンクに失敗する
  ことがある(実機用のリリース構成は通る)。見た目の確認だけなら `npx expo run:ios --configuration Release`
  でシミュレータに入れられる(JS は同梱されるので Metro 不要)。
- 初回は 2026-11-06 に build 1 (version 0.1.0) をアップロード。

## 次にやること
作成・編集・削除 (楽観的更新 + 書き戻し) → 不在・勤務場所の表示 → 引っ張って更新 →
通知・ウィジェット。
