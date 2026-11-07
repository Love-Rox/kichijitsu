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
`signingStyle: automatic` / `uploadSymbols: true` / **`manageAppVersionAndBuildNumber: false`**。
- `manageAppVersionAndBuildNumber` は既定で true で、**重複したビルド番号をアップロードすると、Xcode が黙って番号を繰り上げる**
  (2026-11-06: build 5 のアーカイブを再送して、中身は 5 のまま App Store Connect 上で 6 になり、本物の 6 が 7 になった)。
  必ず false にして、重複は失敗させる。アプリ内の設定メニューの最下段に、実際に入っているビルド番号が出る。
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

## 予定の開始通知
- サーバーからのプッシュは使わず、手元(SQLite)の予定から端末内のローカル通知を予約する(`src/lib/notifications.ts`、expo-notifications)。Apple のプッシュ設定は不要。
- 同期完了・編集・前面復帰・設定変更のたびに、予約を丸ごと作り直す(1.5 秒待ってから)。14 日先まで、iOS の上限 64 件に収まるよう直近 60 件。
- 終日・不在・不参加の予定は通知しない。通知時刻が過ぎた予定は予約しない。ログアウトで予約を全消去。
- 設定(オン/オフ、タイミング)はこの端末だけ(meta: `notifyEnabled` / `notifyLeadMinutes`)。既定はオフ、オンにした時に許可を求める。
- タイミングの既定は「予定の設定に従う」: Web/デスクトップ版と同じ `resolveLeadMinutes`(`@kichijitsu/web/sync/reminderSchedule`)で、予定ごとの Google の通知設定(複数あれば全部)、「既定を使う」予定はカレンダーの既定(`defaultReminderMinutes`)に従う。通知が 1 つも無い予定には出さない。固定(開始時刻 / 5〜30 分前)も選べる。
- Google 側で通知設定が変わると、次の同期で予定・カレンダーのデータが差し替わり、予約が作り直されるので追随する(値はキャッシュしない)。

## ホーム画面ウィジェット
- `apps/mobile/targets/widget/`(Swift / WidgetKit)。`@bacons/apple-targets` の config plugin が、`prebuild --clean` のたびに ios/ へターゲットを生成する(ios/ は生成物でコミットしない)。
- データ: アプリ(JS)が `src/lib/widgetSync.ts` で、直近 7 日・12 件の予定(終日・不在・不参加を除く)を、App Group `group.cc.love-rox.kichijitsu` の UserDefaults("events" に JSON)へ書き、ウィジェットを再読み込みさせる。通知の予約と同じ契機(同期・編集・前面復帰)で更新。
- ログアウトでは `clearWidget()` で空にする(ロック画面・ホーム画面に予定の題が残らないように)。
- サイズは小(直近 2 件)・中(直近 4 件)。予定の開始・終了の時刻で表示が切り替わる。
- 署名: ウィジェット用の App ID(`cc.love-rox.kichijitsu.widget`)と App Group の登録が要る。Apple ID でサインインした Xcode に任せる(`xcodebuild ... -allowProvisioningUpdates`、API キー無し)と自動で登録される。**権限の低い API キーでは作れない**。

## 検索
- ヘッダーの 🔍 から開く(`components/SearchSheet.tsx`、ロジックは `lib/search.ts`)。手元のデータだけで探す(通信なし)。
- タイトル・場所・説明・ゲスト(名前とメール)に、空白区切りの全部の語を含む予定(AND)。全角/半角・大文字小文字は区別しない。
- 繰り返しの予定は、全件を展開せず、一致したシリーズだけを過去 90 日〜先 180 日で展開する。結果は最大 100 件、「これから」(近い順)→「過去」(新しい順)。
- 結果をタップすると、検索のシートを閉じてから詳細を開く(iOS はモーダルを重ねて出せないことがあるため、450ms 待つ)。

## ゲストの追加・削除
- 予定の詳細シートのゲスト欄から。条件は Web 版と同じ `canEditGuests`(自分が主催の、繰り返しでない Google の予定)。ゲストが 0 人でも、編集できる予定には追加欄を出す。
- 通信は `lib/mutations.ts` の `editGuests`: Web 版と同じ**楽観更新 + ロールバック**(押した瞬間に一覧へ反映し、サーバーが拒否したら元に戻す)。送るのは差分(追加/削除するメール)だけで、サーバーが read-modify-write する(手元の一覧は 50 件で打ち切られていることがあるため)。
- 追加すると招待は必ず通知される(サーバー側で固定)。自分・主催者・会議室は外せない。入力の検査は Web 版の `parseGuestEmailInput`。

## アップロードを API キーで行う(Apple ID のセッション切れを避ける)
- Xcode の Apple ID のセッションは切れることがあり(`Failed to Use Accounts`)、そのたびに再サインインが要る。**アップロード(`-exportArchive`)は、App Manager 権限の App Store Connect API キーで通る**(2026-11-07 確認。キーは期限切れにならない)。
- 配置: `.p8` は **リポジトリの外**(`~/.appstoreconnect/AuthKey_<KeyID>.p8`、権限 600)。チャットや git に出さない。Issuer ID は App Store Connect の「統合」の上部にある UUID。
- 実行: `xcodebuild -exportArchive -archivePath … -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/AuthKey_<KeyID>.p8 -authenticationKeyID <KeyID> -authenticationKeyIssuerID <IssuerID>`
- **新しい App ID・App Group・capability が増えるとき(ウィジェットを足したとき等)は、App Manager のキーでは作れない**。そのときだけ Apple ID でサインインした Xcode でアーカイブ/エクスポートして、登録を済ませる。
- Admin 権限のキーは、手元に置かない(作ったら用が済み次第、App Store Connect で取り消す)。

## 予定の色の変更
- 予定の詳細シートの「色」から、Google のイベント色 11 色と「カレンダーの色」(個別色を外す)を選ぶ。繰り返しの予定は、シリーズ全体の色を変える(1 回分だけの色は未対応)。
- サーバーに `POST /api/event/color`(`core/event-color.ts`、`google/event-color.ts`)を追加: Google には `colorId` だけを `events.patch` する(外すときは null)。**ゲストへのメールは出さない**(`sendUpdates=none`。色は見た目だけの属性で、ゲストの予定の中身を変えないため)。
- 手元への反映は保存ボタン方式(サーバーが受け付けてから、画面と SQLite を更新)。色の表は Web 版の `GOOGLE_COLOR_MAP`(`mapGoogle.ts`)と共通。
- **サーバー(Worker)の変更を含む**: アプリより先に `pnpm deploy:sync` が要る(未デプロイだと、色の変更は 404 で失敗する)。

## アイコンと縦の拡大・縮小
- UI のアイコン(‹ › 🔍 ＋ ⋯ と、選択肢の ●/○)は、Phosphor duotone(MIT)の SVG を `react-native-svg` で描く(`components/Icon.tsx`)。m-ai-log と同じ系統で、薄い面 + 線を同じ色で重ねる。絵文字・記号は端末のフォントで見た目が変わるので使わない。
- アイコンの形は `src/assets/iconsData.ts`(生成物)。足すときは `brand/gen-icons.js` の `ICONS` に 1 行足し、`npm pack @phosphor-icons/core` で取り出したフォルダを渡して再生成する(手順はスクリプトの先頭)。
- タイムラインは 2 本指のピンチで縦に拡大・縮小できる(1 時間 28〜160px、既定 52px)。指の中心の下の時刻が動かないよう、スクロール位置を合わせる。倍率は端末に保存し(meta `timelineHourHeight`)、次回も引き継ぐ。ジェスチャ用のライブラリは足さず、`PanResponder` で 2 本指を拾う。予定を掴んでいる(ドラッグ中の)間は、ピンチを始めない。
- 見出しの窓(重なり配置が予定の先頭を隠さない範囲)は px で持ち、倍率に合わせて ms に直す。予定の展開は倍率が変わっても作り直さない。
- 文字の大きさは、共通の `Text` / `TextInput`(`components/ui.tsx`)の `FONT_SCALE`(1.15)で、まとめて拡大している(各画面の `fontSize` はそのまま。`lineHeight` も同じ倍率)。さらに大きく/小さくするときは、この値だけを変える。タイムラインの予定の行数の計算も、この倍率を使う。

## カラーテーマ
- 設定メニュー →「カラーテーマ」で、**外観**(システムに従う / ライト / ダーク)と**アクセント色**(朱[既定]・藍・緑・紫・橙・墨)を選ぶ。選ぶとすぐ反映され、端末の SQLite(meta: `themeAppearance` / `themeAccent`)に保存される。
- 外観は `Appearance.setColorScheme` で OS 側の見た目を上書きする(`lib/themePrefs.ts`。システムに従うときは `"unspecified"`)。確認ダイアログ・キーボード・日時ピッカーも、アプリの外観に揃う。
- アクセント色は `lib/accents.ts` の表(ライト/ダークごとに、アクセント・濃いアクセント・淡い地の 3 色)。`theme.ts` が、選んだ色でパレットを差し替える(`useTheme()` が `useThemePrefs()` を読む)。文字・背景・予定カードの色は変えない。色を足すときは `ACCENTS` に足す。
- 起動直後、保存した設定を読み戻すまでの一瞬は、既定の見た目で出る。ホーム画面のウィジェットには、**アクセント色だけ**が届く(App Group の `theme` キーに、ライト用・ダーク用の色を JSON で書く。`widgetSync.ts` の `writeWidgetTheme`)。ウィジェットの明暗は OS に従い、アプリ内の外観の上書きは届かない(iOS の仕様)。

## 横スワイプで期間を移る
- 日・3日・週・月のすべてで、**横にスワイプすると前後の期間へ移る**(ヘッダーの「前へ/次へ」と同じ移動: 日・3日・週は表示日数ぶん、月は 1 か月)。指に合わせて内容が横に動き、一定以上(画面幅の 1/4 か 90px のどちらか小さいほう、または速いフリック)で切り替わる。足りなければ、元に戻る。切り替わるときは、いまの内容を横へ出し、再描画のあと、新しい内容を反対側から入れる(`CalendarScreen.tsx`)。
- 縦スクロール・タップ・予定の長押しドラッグ・2 本指のピンチとは、ぶつからないようにしてある: 横が縦の 1.8 倍以上、かつ 14px 以上動いたときだけ奪う。長押しドラッグとピンチは、Timeline の側が capture で先に奪うので、スワイプには回らない。切り替え中(読み込み表示)は、スワイプを受け付けない。
- ジェスチャ用のライブラリは足さず、`PanResponder` と `Animated`(ネイティブドライバ)で作っている。
