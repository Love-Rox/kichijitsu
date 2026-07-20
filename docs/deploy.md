# 本番デプロイ手順

本番公開先: **https://kichijitsu.love-rox.cc** (Cloudflare 管理ゾーン `love-rox.cc`)

## サービング構成

- `kichijitsu.love-rox.cc` — Worker `kichijitsu-web` (apps/web の静的アセット。Custom Domain で
  DNS レコードは自動管理される)
- `kichijitsu.love-rox.cc/api/*`, `/auth/*` — Worker `kichijitsu-sync` (apps/sync。zone route。
  同一ホスト上では zone route が Custom Domain より優先されるため、この 2 パスだけこちらに届く)
- 同一オリジンなので CORS 設定は不要。Cookie も `SameSite=Lax` のままでよい。

前提として `love-rox.cc` が対象 Cloudflare アカウントの管理ゾーンとして既に追加されていること。

## 0. 認証

```sh
mise exec -- pnpm --filter sync exec wrangler login
# もしくは CI 等では環境変数 CLOUDFLARE_API_TOKEN を設定しておく
```

以降のコマンドはすべて `apps/sync` に `wrangler` (devDependency) がインストールされている前提で、
`pnpm --filter sync exec wrangler ...` 経由で実行する (apps/web には wrangler を入れていないため、
web 側のデプロイも同じく apps/sync 経由の `wrangler --config ../web/wrangler.jsonc` を使う。
ルートの `deploy:web` / `deploy:sync` スクリプトはこれを内包している)。

## 1. D1 データベースの実体を作成

```sh
mise exec -- pnpm --filter sync exec wrangler d1 create kichijitsu-sync
```

出力される `database_id` を `apps/sync/wrangler.jsonc` の `d1_databases[0].database_id`
(現在はプレースホルダ `00000000-0000-0000-0000-000000000000`) に反映する。

反映後、`apps/sync/wrangler.jsonc` が変わったので型を再生成しておく:

```sh
mise exec -- pnpm --filter sync typecheck
```

## 2. マイグレーションをリモートに適用

```sh
mise exec -- pnpm --filter sync exec wrangler d1 migrations apply kichijitsu-sync --remote
```

未適用のマイグレーションがまとめて本番 D1 に適用される:

- `0001_init.sql` — `users` テーブル (廃止済み。0002 で `accounts` に置き換わる)
- `0002_accounts.sql` — マルチアカウント対応。`accounts(id, profile_id, email,
refresh_token, created_at)` を作り、既存の `users` 行を `profile_id = id` として
  そのままコピーしたうえで `users` を DROP する (「1 ユーザー = 1 プロファイル」という
  前提での素朴な移行で十分と判断した理由は migration ファイル内のコメント参照)。
  ローカルで `wrangler d1 migrations apply kichijitsu-sync --local` を先に試して、
  `wrangler d1 execute kichijitsu-sync --local --command "SELECT * FROM accounts"`
  で移行結果を確認しておくと安心。
- `0003_watches.sql` — リアルタイム反映 (フェーズ4) 用。Google Calendar の push 通知
  (watch channel) の登録状態を持つ `watches(channel_id PK, resource_id, account_id,
calendar_id, profile_id, expiration_ms, created_at)` を作る。`(account_id,
calendar_id)` にユニークインデックスがあり、1 アカウント×1 カレンダーにつき watch は
  常に高々1つ。データを持たない新規テーブルの追加のみで、既存データの移行は無い。
- `0004_owner.sql` — **アカウント設計の分離** (下記参照)。`accounts` に
  `is_owner INTEGER NOT NULL DEFAULT 0` を追加し、既存の束 (同じ `profile_id` を持つ
  アカウント群) ごとに最古 (`created_at` 最小、同着なら `id` 昇順) のアカウントを
  `is_owner=1` にする移行を行う (`profile_id` 自体は変更しない = 既存の束は壊さない)。
  さらに `idx_accounts_one_owner_per_profile` (`profile_id` 上の部分ユニークインデックス、
  `WHERE is_owner = 1`) で「1 プロファイルにつきオーナーは高々1人」を DB レベルでも保証する。
- `0005_visible_calendars.sql` — **カレンダー選択のサーバー保存** (下記参照)。
  「どのカレンダーを表示するか」の選択がこれまで端末ローカル (IndexedDB) のみで、
  端末間で揃わなかった (別端末で一部カレンダーが出ない原因) 問題を解消する。
  選択の実体を持つ `account_visible_calendars(account_id, calendar_id, created_at,
PRIMARY KEY(account_id, calendar_id))` と、そのアカウントが選択を設定済みかを持つ
  `account_calendar_prefs(account_id PRIMARY KEY, configured, updated_at)` の2テーブルを
  新規作成するのみで、既存データの移行は無い。2テーブルに分けているのは「未設定
  (行が無い＝クライアントが primary をデフォルト選択)」と「空選択 (全部外した、という
  明示的な意思)」を区別するため。

### カレンダー選択のサーバー保存 (2026-07-20)

これまで「どのカレンダーを表示するか」はクライアント (IndexedDB) にしか保存されておらず、
端末を跨ぐと選択が揃わなかった。`GET /api/me` の `MeResponse.visibleCalendars`
(`Record<accountId, calendarId[]>`) と `PUT /api/visible-calendars`
(`VisibleCalendarsRequest { accountId, calendarIds }`) でサーバー保存に対応した。

- `GET /api/me` はプロファイルの全アカウントについて `account_calendar_prefs` を引き、
  **configured なアカウントだけ** `visibleCalendars` にエントリを含める (configured で
  選択0件なら空配列、configured でない = 行が無いアカウントはキーごと省略)。集約ロジック本体は
  `apps/sync/src/core/visible-calendars.ts` の `aggregateVisibleCalendars` (純関数・テスト済み)。
- `PUT /api/visible-calendars` (要ログイン + 所属検証) は対象アカウントの
  `account_visible_calendars` を DELETE→INSERT で全置換し、`account_calendar_prefs` に
  `configured=1` を upsert する。D1 の `batch()` で実行するため暗黙のトランザクションになる。
- `DELETE /api/account` でのアカウント削除時は `account_visible_calendars` /
  `account_calendar_prefs` の該当行もあわせて削除する (`disconnectAccount` 内)。
- クライアント側 (apps/web、IndexedDB 保存) の切り替えは今回のスコープ外
  (サーバー API の追加のみ)。

### アカウント設計の分離 (2026-07-20)

**背景のバグ**: 「プロファイル (=セッション) = 複数 Google アカウントの束」という設計で、
束に属する _どのアカウントでログインしても束全体が復活_ していた。スマホで片方の
アカウントでログインすると、PC で `?add=1` で追加しただけの別アカウントまで一緒に
同期されてしまう (プライバシー/取り違えのリスク)。

**修正方針**: kichijitsu の身元 (ログイン identity = オーナー) と、同期アカウント
(接続 = データ源) を分離する。

- プロファイルは **オーナー Google アカウント1つ** に紐づく。通常ログインはオーナーの
  OAuth でのみプロファイルを確立する
- `?add=1` (アカウント追加) で足したアカウントは **接続** (`is_owner=0`, 同期専用)。
  単独ログインでは他人のプロファイルを復活させない
- 接続アカウントで直接ログインした場合は、**そのアカウント自身の新規プロファイル**を
  作る (他人の束は復活させない)

解決ロジックの本体は `apps/sync/src/profile-resolution.ts` の `resolveLoginProfile`
(純関数、テスト済み) と、それを呼び出す `apps/sync/src/routes/auth.ts` の
`/auth/callback` (login モード分岐)。DELETE `/api/account` でオーナーアカウントを
指定した場合は、安全側でプロファイル全体の解除 (+ セッション破棄) に格上げする
(`apps/sync/src/accounts.ts` の `resolveDisconnectTargets`)。

**データモデルの最小変更方針**: `accounts.id` (= Google sub) は今回も PK のまま
(複合キー化はしていない) — そのため1つの Google アカウントは常にどこか1つの
プロファイルにしか属せない。`?add=1` で別プロファイルのオーナーだったアカウントを
接続として付け替えると、元プロファイルはオーナー不在になり残った接続アカウントが
宙に浮く、という矛盾ケースが起こり得るが、今回のスコープでは検出・防止しない
(詳細は `auth.ts` のコメント参照)。「同一 Google sub が複数プロファイルの接続として
同時に存在できる」設計にするには `(profile_id, sub)` の複合キーテーブルへの
大改修が必要で、別途対応とする。

**スコープ外 (別途対応)**: カレンダー選択状態のサーバー同期 (当時はクライアント
ローカルのみ)。今回 (0004) はプロファイル解決ロジックの修正のみに絞った。
→ サーバー保存 API は `0005_visible_calendars.sql` で対応済み (下記参照)。

## 3. Secrets を登録

```sh
mise exec -- pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_ID
mise exec -- pnpm --filter sync exec wrangler secret put GOOGLE_CLIENT_SECRET
mise exec -- pnpm --filter sync exec wrangler secret put SESSION_SECRET
mise exec -- pnpm --filter sync exec wrangler secret put TOKEN_ENC_KEY
```

（値は `apps/sync/.dev.vars.example` のコメント参照。`SESSION_SECRET` と `TOKEN_ENC_KEY` は
`openssl rand -base64 32` などで新規に生成した、ローカル開発用とは別のランダム値を使うこと。
`TOKEN_ENC_KEY` は D1 に保存する refresh_token の at-rest 暗号化 (AES-256-GCM) に使う鍵。
これを失う、または変更すると既存ユーザーの refresh_token が復号できなくなり全員再連携が
必要になるので、生成した値は安全な場所 (パスワードマネージャ等) に控えておくこと。）

## 4. Google Cloud Console 側の設定

OAuth クライアント (`apps/sync/.dev.vars.example` で作成したものと同じクライアント) の
「承認済みのリダイレクト URI」に本番用を追加する:

```
https://kichijitsu.love-rox.cc/auth/callback
```

(ローカル開発用の `http://localhost:8787/auth/callback` は残したままでよい。)

## 5. 招待制 (ALLOWED_EMAILS) の運用

`apps/sync/wrangler.jsonc` の `vars.ALLOWED_EMAILS` はカンマ区切りのメールアドレス allowlist
で、リポジトリのデフォルトは空文字列 (＝全許可、誰でも Google 連携できる)。実際に招待制で
運用したい場合は、デプロイ先の `wrangler.jsonc` の `ALLOWED_EMAILS` に招待する本人のメール
アドレスをカンマ区切りで設定してから `pnpm run deploy:sync` すること (大小文字は区別されない)。
リスト外のメールアドレスで `/auth/callback` に到達した場合、accounts への保存 (refresh_token を
含む) は一切行われず、`APP_URL` へ `?auth_error=not_invited` を付けて 302 で戻される。招待者を
増減したいだけであれば、この値を書き換えて sync を再デプロイするだけでよい (DB 変更は不要)。

## 6. デプロイ

まず apps/web をビルドする (デプロイスクリプトはビルドを行わず、既存の `apps/web/dist` を
そのままアップロードするだけなので、必ず先にビルドすること):

```sh
mise exec -- pnpm --filter web build
```

その後、両方の Worker をデプロイする (順不同で問題ないが、`/api`・`/auth` を早く有効にしたい
場合は sync を先にすると良い):

```sh
mise exec -- pnpm run deploy:sync
mise exec -- pnpm run deploy:web
```

## 7. 検証

```sh
curl -s https://kichijitsu.love-rox.cc/api/me
# => {"connected":false,"accounts":[]}

curl -sI https://kichijitsu.love-rox.cc/
# => 200 (index.html が返る)
```

ブラウザで `https://kichijitsu.love-rox.cc/` を開いてトップページが表示されることを確認する。
続けて `/auth/login` から Google 連携フローが正常に完走し、連携後に `/api/me` が
`{"connected":true,"accounts":[{"id":"...","email":"..."}]}` を返すことも確認する。
複数アカウントを持たせたい場合は `/auth/login?add=1` (有効なセッションが必要) で
現在のプロファイルにもう1つ Google アカウントを追加できる。

## 8. リアルタイム反映 (watch channel / webhook / Cron) の注意点

フェーズ4で追加した、Google Calendar の変更をほぼリアルタイムでクライアントへ伝える仕組み。
「通知はトリガー、差分はクライアントが `/api/sync` で取る」設計 (SSE はイベント本体を運ばない)
なので、以下は本番でこの仕組みが機能するための前提条件であり、追加の secrets 登録は不要
(既存の `SESSION_SECRET` を webhook トークンの HMAC 鍵として流用している)。

- `POST /api/watch` は Google の `events.watch` を呼んで push 通知チャネルを登録する。
  address には `vars.WEBHOOK_BASE_URL` (デフォルト `https://kichijitsu.love-rox.cc`、
  `.dev.vars` では意図的に上書きしない) + `/api/webhook/google` を渡す。**Google は
  webhook の送信先ドメインが [Google Search Console](https://search.google.com/search-console)
  で所有権検証済みであることを要求する**ため、`love-rox.cc` (または利用する Custom Domain)
  がまだ検証されていない場合は事前に検証しておくこと。未検証の場合、登録は失敗するが
  best-effort 設計により `POST /api/watch` 自体は 200 (`{ watching: false }`) を返し、
  UserSyncDO のポーリングフォールバック (10分間隔) が代わりに機能する。
- `POST /api/webhook/google` はセッション不要 (Google からの通知を受ける公開エンドポイント)。
  `kichijitsu.love-rox.cc/api/*` の zone route に含まれるのでデプロイと同時に有効になる。
  X-Goog-Channel-Token を `SESSION_SECRET` から HMAC で再計算して検証しているため、
  `SESSION_SECRET` を変更すると既存の watch はすべて無効化される (次の Cron 実行、または
  クライアントの再 `POST /api/watch` で再登録されるまでの間はポーリングフォールバックのみで動く)。
- Cron トリガー (`wrangler.jsonc` の `triggers.crons`, 6時間おき) は `wrangler deploy` 時に
  自動で登録される。追加の手動設定は不要。期限が24時間以内に迫った watch を
  stop → 再登録する (`selectWatchesNeedingRenewal` / `scheduled` ハンドラ、
  `apps/sync/src/index.ts`)。ローカルではスケジュールが自動発火しないため、動作確認したい
  場合は `wrangler dev` 起動後に `curl http://localhost:8787/cdn-cgi/handler/scheduled` で
  手動発火できる。

## 参考: 設定変更後の型再生成

`apps/sync/wrangler.jsonc` を変更した場合は必ず以下を実行してから型チェック・デプロイすること
(bindings/vars の変更が `Env` 型に反映される):

```sh
mise exec -- pnpm --filter sync typecheck
```
