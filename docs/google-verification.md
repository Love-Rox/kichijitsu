# Google OAuth 本番公開 (verification) の準備チェックリスト

公式インスタンスの OAuth 同意画面を「テスト」から「本番」に切り替え、
誰でも連携できる状態にするための手順。カレンダーは **sensitive scope**
（restricted ではない）ため、CASA セキュリティ監査は不要。審査は通常数日〜数週間。

## コード側の準備（リポジトリで対応）

- [x] プライバシーポリシー公開: https://kichijitsu.love-rox.cc/privacy.html（Limited Use 明記済み）
- [x] 利用規約公開: https://kichijitsu.love-rox.cc/terms.html
- [x] refresh token の暗号化保存（AES-256-GCM）
- [x] **スコープの最小化**: `https://www.googleapis.com/auth/calendar`（フル）をやめ、
      `calendar.events`（予定の読み書き）+ `calendar.calendarlist.readonly`（カレンダー一覧）へ。
      狭いスコープは審査が楽で、同意画面の文言もユーザーに優しい
- [x] granular consent 対応: token レスポンスの `scope` フィールドを確認し、
      必要スコープが付与されなかった場合のエラーハンドリング
      (`hasRequiredScopes` / apps/sync/src/google/oauth.ts。旧フルスコープで既に連携済みの
      ユーザーは上位互換として引き続き通る)
- [x] **連携解除（アカウント削除）**: `DELETE /api/account` — Google の revoke エンドポイントで
      トークン失効 → DO の同期状態クリア → D1 の行削除 → sid cookie 削除、の順で実行
      (この順序は revoke 前に行を消して復号不能にする事故を防ぐため)。
      UI も完了 (設定モーダルの「アカウント」セクション、
      apps/web/src/components/settings/AccountsSection.tsx。インライン2段階確認つき)
- [x] アプリ内からプライバシーポリシーへのリンク: ツールバー (AppToolbar.tsx /
      toolbarMenuItems.ts)・カレンダーペイン (CalendarPane.tsx)・設定モーダル
      (SettingsModal.tsx) の3箇所

**コード側の準備は完了しており、審査はいつでも提出できる (2026-08-06 時点)。**

## Google Cloud Console での手作業

1. **ドメイン所有権確認**: [Search Console](https://search.google.com/search-console) で
   `love-rox.cc` を DNS TXT レコードで確認（DNS は Cloudflare）
2. **OAuth 同意画面のブランディング**:
   - アプリ名: `kichijitsu`
   - サポートメール / デベロッパー連絡先: kichijitsu@love-rox.cc
     （**注意**: 同意画面の「ユーザーサポートメール」欄はドロップダウン選択式で、
     ログイン中アカウントのメールか、自分が管理者の Google グループしか選べない。
     kichijitsu@love-rox.cc を使うには Google グループを作ってこのアドレスを充てるか、
     この欄だけ自分の Gmail にする。「デベロッパーの連絡先情報」欄は自由入力なので
     kichijitsu@love-rox.cc をそのまま使える。ページ上の連絡先表記は kichijitsu@ で統一済み）
   - アプリロゴ: 120×120 PNG（`brand/tile.svg` から書き出し。**ロゴを設定すると
     ブランド審査が追加で走る**ので、急ぐならロゴ無しで先に申請する選択肢もある）
   - アプリのホームページ: https://kichijitsu.love-rox.cc
   - プライバシーポリシー / 利用規約 URL: 上記
   - 承認済みドメイン: love-rox.cc
3. **公開ステータスを「本番」へ** → 審査提出

## 審査提出時の説明文

**先に「データアクセス」画面へ3スコープを登録すること** — 登録しないと「機密性の高い
スコープをリクエストしていないため検証は必要ありません」と判定され、申請自体ができない
（2026-08-06 の障害記録を参照）。

各スコープについて「読み取りに何が要るか」「書き込みに何が要るか」を分けて書く。
Google は抽象的な説明を嫌うので、**UI 上のどの操作が API のどの呼び出しになるか**まで
書き下す。以下は実装 (apps/sync/src/google/) と一致していることを確認済みの文面。

> **kichijitsu** is a personal calendar client for Google Calendar. It displays the
> user's events on a week/day timeline, lets them create and edit events directly by
> dragging, and shows their Google Tasks alongside the calendar.
>
> **`https://www.googleapis.com/auth/calendar.events`**
> - *Read*: fetch the user's events to render the calendar timeline.
> - *Write*: create, update and delete events when the user adds, drags, resizes,
>   duplicates or deletes them in the UI, and respond to invitations (RSVP).
>   Additionally, when — and only when — the user configures a "block" rule, we create
>   placeholder "busy" events on a destination calendar they choose, so that time
>   already booked on one calendar is visible as busy on another.
> - We request `calendar.events` rather than the full `calendar` scope because we never
>   need to create, delete or modify calendars themselves.
>
> **`https://www.googleapis.com/auth/calendar.calendarlist.readonly`**
> - *Read only*: list the user's calendars so they can choose which ones to display and
>   which calendar to write to. We never modify the calendar list.
>
> **`https://www.googleapis.com/auth/tasks`**
> - *Read*: `tasklists.list` and `tasks.list`, to show the user's task lists and tasks
>   next to their calendar.
> - *Write*: `tasks.patch`, restricted to the `status` field only, so the user can tick
>   a task complete (or undo it) from the calendar UI. We do not create, delete or
>   rename tasks.
> - `tasks.readonly` is not sufficient because completing a task is a write.
>   `https://www.googleapis.com/auth/tasks` is the narrowest scope that allows it.
>
> **`openid`, `email`**
> - To identify which Google account signed in, so the app can associate it with the
>   right tokens and let the user connect several Google accounts at once.
>
> **Data handling.** Event and task content is never stored on our servers. It is
> delivered to the user's browser and kept in IndexedDB on their own device. Our servers
> (Cloudflare Workers + D1) store only encrypted OAuth refresh tokens, account
> identifiers, sync cursors and user settings. Our Limited Use disclosure is at
> https://kichijitsu.love-rox.cc/privacy.html

## デモ動画（YouTube 限定公開でよい）

### 撮影前の準備（ここを外すと差し戻される）

- [ ] **本番環境で撮ること**。localhost や dev で撮ったものは受け付けられない
- [ ] **同意画面の言語を English にする**。同意画面の**左下に言語切り替え**があるので、
      日本語アカウントでもそこで English へ変える。日本語のままだと審査側が読めず差し戻る
- [ ] **ブラウザウィンドウを横に広くする**。同意画面の URL に含まれる
      `client_id` がアドレスバーで**読める幅**にしておく ―― 審査側はこれで
      「申請されたクライアントと同一か」を確認する。ウィンドウが狭いと URL が省略されて写らない
- [ ] **アドレスバーを常時映す**。全画面表示や URL を隠すブラウザ設定にしない
- [ ] 申請したアプリ名・ロゴが同意画面に出ることを確認しておく（ブランディングは検証済み）
- [ ] 未確認アプリの警告が出るのは**この段階では正常**。そのまま「詳細」→続行して撮ってよい

### 撮影手順

1. https://kichijitsu.love-rox.cc を開く（URL バーが見えること）
2. 「Google 連携」→ OAuth 同意画面。**申請した3スコープが並んで表示されている画面を、
   URL の client_id ごと映す**（ここが最重要カット）→ 許可
3. カレンダーが表示される（スコープの利用目的 = 表示）
4. 予定をドラッグで編集 → Google カレンダー本体にも反映されることを見せる（= 書き込みの利用目的）
5. **タスク**（`tasks` スコープの使途。申請したスコープは全部映す必要がある）:
   右ペインにタスク一覧が出ること（= `tasklists.list` / `tasks.list` の用途 = 表示）→
   枡チェックボックスを押して完了にする → Google ToDo リスト側でも完了になっていることを
   見せる（= `tasks.patch` の用途 = 完了状態の書き戻し）。
   **書き込みが status だけであることが伝わるよう、タスクの新規作成や削除は映さない**
   （実際に実装していない機能を期待させないため）
6. 「連携解除」を実行（`DELETE /api/account`）→ ログアウト状態に戻ることを見せる。
   可能なら Google アカウントの「サードパーティ製アプリとサービス」ページ
   (https://myaccount.google.com/connections) から kichijitsu が消えている
   (= 実際に revoke された) ことも合わせて見せると、より説得力がある

### よくある差し戻し理由

- **同意画面が日本語のまま** → 左下で English に切り替える
- **client_id がアドレスバーで読めない** → ウィンドウを広げて撮り直す
- **申請スコープと同意画面のスコープが一致しない** → データアクセス画面の登録内容と
  `OAUTH_SCOPES` (apps/sync/src/google/oauth.ts) が一致しているか確認する。
  **コード側だけ増やしてコンソールに登録し忘れる**のが今回の障害の原因だった
- **一部のスコープの使途が映っていない** → 申請した3つすべてについて、
  読み取り (表示) と書き込み (編集・完了) の両方を映す
- **本番環境でない** → localhost や dev で撮らない

アプリ UI は日本語なので、**英語のナレーションか字幕**を付けると審査が速い
（必須ではないが、審査側が操作の意味を追えるほうが差し戻りにくい）。

## 運用面の注意

- 本番公開後も `ALLOWED_EMAILS` は有効なまま使える（同意はできるが登録は拒否される）。
  「審査は通しておき、開放のタイミングは allowlist で制御」が可能
- **100 ユーザー制限が外れるのは「審査を通したとき」であって「本番にしたとき」ではない。**
  未審査のまま本番へ切り替えても上限は残り、しかも sensitive scope を要求していると
  **Sign in with Google 自体が無効化されうる** (下の障害記録を参照)
- 審査中もテストユーザーは従来どおり利用可能

## 障害記録: 未審査のまま本番化して Sign In が無効化された (2026-08-06)

**症状**: 特定アカウントの同期が2日以上止まり (`refreshAccessToken` が
alarm 側 246回・RPC 側 66回失敗)、再連携しようとすると
`401: disabled_client` /「Sign in with Google temporarily disabled for this app.
This app has not been verified yet by Google」。

**原因**: 同意画面が **「本番」かつ未審査**だった。カレンダーは sensitive scope なので、
この状態では Google が Sign In を無効化する。既存のリフレッシュトークンも順次失効する
ため、放置すると**全アカウントが止まる** (他アカウントが当初動いていたのは、
まだトークンが生きていただけ)。

**対処**: 「テスト」へ戻せば即座に復旧するが、テスト状態では
[リフレッシュトークンが7日で失効する](https://developers.google.com/identity/protocols/oauth2#expiration)
(basic profile scope のみの場合を除く。kichijitsu は該当しない) ため、
全アカウントが毎週再連携を要求される。恒久対応は審査提出。
**「テストへ戻して復旧 → 並行して審査提出 → 承認後に本番へ」が最短。**

**真の原因 (同日、追調査で判明)**: 上は症状であって原因ではなかった。
**「データアクセス」画面に sensitive スコープが1つも登録されていなかった。**
検証センターの Data access status が
「アプリは機密性の高いスコープや制限付きスコープをリクエストしていないため、
検証は必要ありません」と表示されており、Google は**このアプリが sensitive スコープを
要求していないと認識**していた。一方コードは calendar.events /
calendar.calendarlist.readonly / tasks の3つ (すべて sensitive) を実行時に要求していた。

申告されていない機密スコープを要求するアプリは未確認アプリとして扱われ、警告表示・
トークン失効・アカウントによってはハードブロックの対象になる。

**「検証済み」の読み違いに注意**: 概要画面の「アプリの検証 ✅ アプリが Google によって
検証されました」は**ブランディングの検証**であって、スコープの検証ではない。
検証センターでは Branding status と Data access status が別々に表示される。
**この2つを混同すると「審査は通っているのに未確認警告が出る」という矛盾に見える。**

**正しい対処**: データアクセス画面に3スコープを登録する → Data access status が
「検証が必要」に変わる → 申請する。登録しない限り申請自体ができない。

**教訓**: 「本番にする」「ブランディングが検証される」「スコープの検証が通る」は**全部別**。
以前ここに書いてあった「本番化で100ユーザー制限が撤廃される」という誤解も含め、
段階を1つにまとめて考えると原因を見失う。**実行時に要求しているスコープと、
コンソールに登録されているスコープが一致しているか**を最初に確かめること。
