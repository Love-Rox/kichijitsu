# kichijitsu MCP サーバー 設計メモ

2026-07-19 ユーザー発案。「公式 API」の提供形態として MCP サーバーを用意する。
Claude 等のエージェントがユーザーの代わりに予定を読み書きできるようになる。
Notion Calendar には無い差別化要素。

## 方針

- Cloudflare の McpAgent（Durable Object ベース、Streamable HTTP）で実装。
  既存の Workers + D1 + DO インフラに同居させる（apps/mcp or apps/sync に追加）
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

- ツール: `log_work_interval { start, end, repo, branch, issueRef?, agent }`
  （SessionStart/Stop hook から呼ぶ。issueRef はブランチ名/commit から推定）
- **保存先は Google カレンダー自体**: 専用の「kichijitsu 実績」カレンダーに
  イベントとして書き戻す。サーバーは予定を保存しない原則を維持し、
  データはユーザーの Google に置かれ、表示は通常の同期パイプラインが拾う
- hooks は非対話のため、MCP OAuth とは別に自動化用トークン（PAT）を用意する
- 予定（作業キューからのタイムブロック）と実績（hook 記録）を issueRef で
  突き合わせて item 単位のレポートにする

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

成功すると `{ calendarId, eventId }` を 200 で返す。認証失敗は 401、入力不正
(start>=end・repo 欠落など) は 400、Google 側の失敗は 502。issueRef はブランチ名や
commit message から推定して渡す (推定ロジック自体は hook 側の責務、今回のサーバー実装
スコープ外)。

対象アカウントは常にプロファイルの owner アカウント (`accounts.is_owner = 1`) — 呼び出し元が
accountId を指定する余地は無い (MCP ツール `log_work_interval` も REST 経路と同じ解決を使う)。

## 実装タイミング

Google 同期の実 E2E → 書き戻し（フェーズ5）が動いてから。
書き込み系ツールは楽観的更新のロールバック機構を流用する。
実装時は cloudflare:build-mcp スキルを参照。

## 運用上の注意: デプロイ後はクライアント再接続が必要（2026-07-21 実地で判明）

`wrangler deploy` しても、**すでに接続中の MCP クライアントには新コードが即座には反映されない**。

- McpAgent は Durable Object なので、**接続を保持している DO インスタンスは旧コードのまま動き続ける**。
- **ツールのスキーマ（名前・説明・入力）もクライアントが接続時にキャッシュ**する。
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
