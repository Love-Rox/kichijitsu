# kichijitsu MCP サーバー 設計メモ

2026-07-19 ユーザー発案。「公式 API」の提供形態として MCP サーバーを用意する。
Claude 等のエージェントがユーザーの代わりに予定を読み書きできるようになる。
Notion Calendar には無い差別化要素。

## 方針

- Cloudflare Agents SDK の `createMcpHandler`（`agents/mcp/server`、ステートレス、
  Streamable HTTP）で実装。既存の Workers + D1 インフラに同居させる（apps/sync）
  - 2026-07-28 仕様への追随で `McpAgent`（Durable Object ベース）から移行した。
    → 「準拠している仕様バージョン」節を参照
- エンドポイント: `https://kichijitsu.love-rox.cc/mcp`（同一オリジン維持）または
  `mcp.kichijitsu.love-rox.cc`
- **read-through 原則**: ツールは DO 経由で Google から取得して返すだけ。
  サーバーに予定を永続化しない（既存の設計原則を維持）
- 認証: MCP 標準の OAuth（`workers-oauth-provider`）。
  MCP クライアント → kichijitsu アカウント → 保存済み Google トークンの委譲。
  ALLOWED_EMAILS の招待制がそのまま適用される
- Google スコープの追加は不要（本人の既存トークンで代行）

## 初期ツールセット

| ツール                                           | 内容                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `list_events`                                    | 期間指定で予定一覧（tz 明示、繰り返しは展開済みで返す）            |
| `search_events`                                  | キーワード検索                                                     |
| `create_event` / `update_event` / `delete_event` | 予定の書き込み（確認プロンプト前提の設計に）                       |
| `suggest_free_slots`                             | 指定期間・所要時間から空き時間候補を返す（エージェント利用の主役） |
| `complete_task` ほか                             | Google タスク連携後に追加                                          |

## エージェントの作業時間記録（ユーザー発案 2026-07-19）

Claude Code 等の **hooks から作業セッションを記録する**ことで、GitHub 連携の
時間計測（予定 vs 実績）の「実績」を全自動で取る。手動タイマーより楽で、
アクティビティ推定より正確な第3の経路。

- ツール（実装済み、いずれも hook / MCP クライアントの両方から使える）:
  - `log_work_interval { start, end, repo, branch?, issueRef?, agent?, timeZone? }`
    — 開始と終了が揃った**完了区間**を1件記録する（Stop hook から1回で書く経路）
  - `start_work_interval { repo, issueRef?, branch?, agent?, start?, timeZone? }`
    — **開始だけ**を記録する（後述の開区間を1本立てる。SessionStart hook 用）
  - `stop_work_interval { repo, issueRef?, end?, timeZone? }`
    — 対応する開区間に end を書き込んで確定する（Stop hook 用）
  - `work_summary { since?, until? }` — 記録済みの実績を repo + issueRef 単位で集計して返す
    (2026-07-25: issueRef が `owner/repo#番号` の完全参照なら「issue の所属 repo + 番号」へ
    正規化してから集計する。UI 由来の素の番号と同じ issue が1グループにまとまる ―― 集計の
    定義は `packages/shared` に一本化され、web の実績履歴と数字が食い違わなくなった)
    （読み取り専用。確定済みの区間のみが対象で、実行中の開区間は含まれない）
- **保存先は kichijitsu の D1（`work_logs` テーブル）**。当初の設計は「専用の
  『kichijitsu 実績』カレンダーへイベントとして書き戻す」だったが、カレンダーの新規作成には
  `calendar.events` スコープでは足りず本番で 403 になったため、2026-07-21 に D1 保存へ切り替えた。
  work-log は Google に正本が無いアプリ固有データなので、「サーバーは Google イベント本体を
  持たない」原則には反しない（詳細は `apps/sync/src/core/work-log.ts` 冒頭のコメント）。
  Google アカウントの解決は不要になった（`profileId` だけで書ける）ため、**owner アカウント
  （`accounts.is_owner = 1`）を解決する処理は廃止済み**。呼び出し元が accountId を渡す余地も無い。
- hooks は非対話のため、MCP OAuth とは別に自動化用トークン（PAT）を用意する
- 予定（作業キューからのタイムブロック）と実績（hook 記録）を issueRef で
  突き合わせて item 単位のレポートにする

### 開区間（実行中）の扱い

`start_work_interval` で立てた行は `work_logs.end_ms IS NULL` の状態で保存される
（= 開始済み・未停止。マイグレーション `0011_work_logs_open_intervals.sql`）。

- **一意性**: `(profile_id, repo, COALESCE(issue_ref, ''))` ごとに開区間は高々1本
  （部分ユニークインデックス `idx_work_logs_open`、`WHERE end_ms IS NULL`）。
  `issue_ref` の NULL と空文字は同一キーとして扱う。同じキーで再度開始しても新規作成せず、
  既存を返す（`{ id, alreadyOpen: true }`）。二度押し等で同時に2本走った場合も、
  DB の制約で負けた側を「既に開始中」として吸収する（500 にはしない）。
  確定済み（`end_ms` 非 NULL）の行は同じキーで何本でも持てる。
- **孤立停止は無視**: 対応する開区間が無い `stop_work_interval` は何も記録せず
  `{ closed: false, reason: "no_open_interval" }` を返す（0分の偽の実績を作らないため）。
- **停止時の最小区間長**: `end` が `start + 1分` より前なら `start + 1分` にクランプする
  （クライアント側の手動タイマーと同じ挙動）。
- **12時間で自動クローズ**: 停止し忘れた開区間は Cron（6時間おき）が
  `end_ms = start_ms + 12時間` に丸めて閉じる（実行中が無限に伸びないようにするため）。
  この自動クローズ分も通常の確定済み区間として集計に入る。
- 実行中の一覧は `GET /api/work-logs/open` で取得する。集計系（`work_summary` /
  `GET /api/work-logs`）は確定済みの区間だけを返し、実行中は混ぜない。
- 実行中の行も `PATCH /api/work-logs/:id`（手動訂正、cookie 認証）で編集できるが、
  `repo`/`issueRef` を「既に別の開区間が走っているキー」に変える更新は上の一意制約と両立しない
  ため `409 { "error": "work_log_conflict" }` を返す（入力自体は正しいので 400 ではない）。

### hook からの記録方法 (実装後、2026-07-21)

Claude Code の SessionStart/Stop hook 等、非対話のシェルから `curl` 一発で記録できる。
認証は MCP トークンの Bearer (`/api/mcp-tokens` で発行したもの)。トークンは環境変数から
読む (設定ファイルに直書きしない)。

```sh
curl -sf -X POST https://kichijitsu.love-rox.cc/api/work-intervals \
  -H "Authorization: Bearer ${KICHIJITSU_MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "start": "'"$SESSION_START_ISO"'",
    "end": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "repo": "Love-Rox/kichijitsu",
    "branch": "'"$(git branch --show-current)"'",
    "agent": "claude-code"
  }'
```

成功すると `{ id }` (D1 の `work_logs.id`) を 200 で返す。認証失敗は 401、入力不正
(start>=end・repo 欠落など) は 400。issueRef はブランチ名や commit message から推定して渡す
(推定ロジック自体は hook 側の責務、今回のサーバー実装スコープ外)。

書き込み先は D1 の `work_logs` のみで Google は呼ばないため、Google 起因の 502 は無い。
対象は Bearer トークンが指すプロファイル自身 — accountId (Google アカウント) の解決は
一切行わない (MCP ツール `log_work_interval` も同じ)。

開始/停止を別々に打つ場合は同じ Bearer 認証で以下を使う (`repo` + `issueRef` が開区間のキー):

```sh
# セッション開始時 (start 省略時はサーバーの現在時刻)
curl -sf -X POST https://kichijitsu.love-rox.cc/api/work-intervals/start \
  -H "Authorization: Bearer ${KICHIJITSU_MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"Love-Rox/kichijitsu","branch":"'"$(git branch --show-current)"'","agent":"claude-code"}'
# => { "id": "...", "alreadyOpen": false }   (既に開始中なら alreadyOpen: true で既存の id)

# セッション終了時 (end 省略時はサーバーの現在時刻)
curl -sf -X POST https://kichijitsu.love-rox.cc/api/work-intervals/stop \
  -H "Authorization: Bearer ${KICHIJITSU_MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"Love-Rox/kichijitsu"}'
# => { "closed": true, "id": "..." }
#    対応する開始が無ければ { "closed": false, "reason": "no_open_interval" } (200、何も記録しない)
```

いずれも `start`/`stop` は冪等に近い扱い (二重開始は既存を返す、孤立停止は何もしない) なので、
hook の再実行やクラッシュ後の再送で偽の実績が増えることはない。

## 準拠している仕様バージョン（2026-08-04 時点）

**次に仕様が変わったときのために、ここを必ず更新すること。**

| 項目                     | 値                                                                       |
| ------------------------ | ------------------------------------------------------------------------ |
| 対応する MCP 仕様        | **`2026-07-28`**（ステートレス）と **`2025-11-25` 以前**（`initialize`）の両方 |
| トランスポート           | Streamable HTTP（単一エンドポイント `POST /mcp`）                        |
| 実装                     | `agents/mcp/server` の `createMcpHandler` + MCP SDK v2 (`@modelcontextprotocol/server`) |
| 公開している capability  | `tools` のみ（resources / prompts / logging / completion は未実装）      |

出典（一次情報）:

- 仕様本体: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- 適合性テスト: <https://github.com/modelcontextprotocol/conformance>（`npx @modelcontextprotocol/conformance server --url <url>`）

`2026-07-28` は「MCP 史上最大の改訂」で、`initialize` ハンドシェイクとプロトコルレベルの
セッション（`Mcp-Session-Id`）が**廃止**された。リクエストごとに `_meta` で
プロトコルバージョンとクライアント capability を運び、サーバーは `server/discover` を
**MUST** で実装する。旧世代の `McpAgent`（Durable Object + SDK v1）はこの形を話せず、
agents 0.20.0 で deprecated / feature-frozen になったため乗り換えた。

### 後方互換（既存クライアントは壊れない）

`createMcpHandler` は 1 本のハンドラで**両世代を同時に**受ける。

- 新世代（`2026-07-28`）: `_meta` エンベロープ付きのリクエスト＋`server/discover`
- 旧世代（`〜2025-11-25`）: `legacy: "stateless"` レーンが `initialize` を受ける
  （`apps/sync/src/routes/mcp.ts` で明示的に既定のまま指定している）

`2026-07-28` は `initialize` からは**決して**ネゴシエートされない（SDK が
旧世代の候補リストと新世代のリストを意図的に分離しているため）。設定済みの Claude 等は
これまで通り `2025-11-25` で接続する。ローカル `wrangler dev` に対して
`initialize` @ `2025-06-18` / `2025-11-25` と、新世代の `server/discover` /
`tools/list` / `tools/call` の両方が通ることを確認済み。

### 適合性テストの結果（ローカル `wrangler dev` に対して実施）

⚠️ **適合性テストを本番エンドポイントに向けないこと。** ツールを実際に呼ぶため、
本番に向けると利用者の実カレンダーに予定が作られ得る。検証は必ずローカルで行う。

主要シナリオ（`--spec-version 2026-07-28 --suite all`）:

| シナリオ                   | 結果                                            |
| -------------------------- | ----------------------------------------------- |
| `server-stateless`         | 24 / 24（テスト可能なチェックは全通過）         |
| `http-header-validation`   | 13 / 13                                         |
| `tools-list`               | 通過                                            |
| `dns-rebinding-protection` | 2 / 2                                           |
| `caching`                  | `tools/list` の `ttlMs`/`cacheScope` は通過     |
| `sep-2164-resource-not-found` | 通過                                         |

残りの不通過はすべて **"Not testable"**（適合性スイート側が要求する診断用の
フィクスチャツール ―― `test_simple_text` / `test_missing_capability` など ―― を
kichijitsu が実装していない、または resources/prompts/elicitation の capability 自体を
公開していないため）。適合性スイートの server シナリオは**固定名のフィクスチャツールしか
呼ばない**（`tools/list` で見つけたツールを呼ぶことはない）ので、`create_event` 等の
副作用のあるツールが適合性テストで実行されることはない。

### Origin 検証（DNS リバインディング対策）

MCP の Streamable HTTP は「Origin ヘッダが**存在して**不正なら 403」を **MUST** で
要求する。`apps/sync/src/mcp-origin.ts`（純関数 + テスト）が担当し、
`routes/mcp.ts` で**認証より先に**評価する。

- Origin **無し**は許可する ―― Claude Desktop / Claude Code 等の非ブラウザ
  クライアントは Origin を送らない。ここを必須にすると既存クライアントが全滅する。
- 同一オリジンと loopback のみ許可。opaque（`Origin: null`）と不正形式は拒否。
- ハンドラ側の Origin 検証は `allowedOriginHostnames: "*"` で無効化している。
  **これは `mcp-origin.ts` とセットで初めて安全** ―― 片方だけ消さないこと。

## 実装タイミング

Google 同期の実 E2E → 書き戻し（フェーズ5）が動いてから。
書き込み系ツールは楽観的更新のロールバック機構を流用する。
実装時は cloudflare:build-mcp スキルを参照。

## 運用上の注意: デプロイ後はクライアント再接続が必要（2026-07-21 実地で判明）

`wrangler deploy` しても、**すでに接続中の MCP クライアントには新コードが即座には反映されない**。

- **ツールのスキーマ（名前・説明・入力）はクライアントが接続時にキャッシュ**する。
  `2026-07-28` ではさらに `tools/list` の応答が `ttlMs` / `cacheScope` の
  キャッシュヒントを持つため、クライアント側がその間は再取得しないことがある。
- ~~McpAgent は Durable Object なので、接続を保持している DO インスタンスは旧コードの
  まま動き続ける~~ ―― **ステートレス化（2026-07-28 対応）で解消**。リクエストごとに
  サーバーインスタンスを作り直すので、旧コードを掴んだ DO が residual に残ることは無い。
- そのため、デプロイ後の検証は **MCP クライアント（Claude Code / Claude Desktop）を再起動**してから行うこと。
  再起動しないと「直したはずの挙動が変わらない」ように見える。

同様に、**トークンを再発行（＝旧トークンを失効）した場合も、起動中のセッションは旧トークンを掴んだまま**になり
401 が続く。Claude Code はこの 401 を `requires re-authorization (token expired)` と表示するが、
kichijitsu の MCP トークンに**有効期限は無い**（`mcp_tokens` に期限カラムを持たない）ので、
この表示が出たら実際は「トークンが失効/未登録」か「セッションが古い」のどちらか。
`mcp_tokens.last_used_at` を見れば **サーバー側で認証が通ったことがあるか**を客観的に判定できる
（null のままならクライアントが新トークンを送れていない）。

### スキーマと実装の乖離に注意（同日の実例）

`suggest_free_slots` のツール説明・入力スキーマは当初から `stepMinutes`/`maxCandidates` を
公開していたが、`computeFreeSlots` 本体が未対応で**空き区間ごとに1候補しか返していなかった**。
ツール説明は「エージェントとの契約」なので、**説明で約束した挙動を実装が満たしているか**を
実接続で確認すること（モックテストだけでは乖離に気づけない）。
