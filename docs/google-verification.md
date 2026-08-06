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

## 審査提出時の説明文（下書き）

> kichijitsu is a calendar client application. It requests:
>
> - `calendar.events` — to read the user's calendar events for display in the app,
>   and to create/update events when the user edits them in the app.
> - `calendar.calendarlist.readonly` — to list the user's calendars so they can
>   choose which calendar to display.
>
> Event data is synced directly to the user's browser (IndexedDB) and is never
> stored on our servers. Our servers store only encrypted OAuth tokens and sync
> cursors. See https://kichijitsu.love-rox.cc/privacy.html

## デモ動画の構成（YouTube 限定公開でよい）

1. https://kichijitsu.love-rox.cc を開く（URL バーが見えること）
2. 「Google 連携」→ OAuth 同意画面（**スコープが表示される画面を必ず映す**）→ 許可
3. カレンダーが表示される（スコープの利用目的 = 表示）
4. 予定をドラッグで編集 → Google カレンダー本体にも反映されることを見せる（= 書き込みの利用目的）
5. 「連携解除」を実行（`DELETE /api/account`）→ ログアウト状態に戻ることを見せる。
   可能なら Google アカウントの「サードパーティ製アプリとサービス」ページ
   (https://myaccount.google.com/connections) から kichijitsu が消えている
   (= 実際に revoke された) ことも合わせて見せると、より説得力がある

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

**教訓**: 「本番にする」と「審査を通す」は別。前者だけを先に行うと、
以前ここに書いてあった「本番化で100ユーザー制限が撤廃される」という誤解のまま、
**動いていたものが後から止まる**。切り替えは審査承認とセットで行うこと。
