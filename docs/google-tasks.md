# Google タスク連携 設計メモ

2026-07-19 ユーザー決定: Google Tasks もカレンダーと一緒に扱う。

## API の性質（カレンダーとの違い）

| | Calendar | Tasks |
|---|---|---|
| 差分同期 | syncToken | `updatedMin` + `showDeleted=true` のポーリング（syncToken なし） |
| push 通知 | watch channel | **なし** — 定期ポーリング or 手動更新のみ |
| 期限の精度 | 日時 | **日付のみ**（`due` は RFC3339 形式だが時刻は API に捨てられる） |
| スコープ | calendar.events 等 | `https://www.googleapis.com/auth/tasks`（sensitive） |

## 設計方針

- **表示先は日付レーン（終日レーン）**。時刻を持たないので週グリッドには置かない。
  この日付レーンは GitHub 連携の期限/milestone と共用する — 一度作れば両方載る
- source に `'gtasks'` を追加。tasklist ごとに DO へ `updatedMin` カーソルを保存し、
  既存の同期パイプライン（Worker → DTO → クライアント正規化 → IndexedDB）を流用
- 完了操作は**枡チェックボックス（完了＝押印）**。tasks.patch の status 書き換えで
  楽観的更新 + ロールバックの流儀もカレンダーと共通
- 書き戻し: 完了/未完了、タイトル・期限の編集、新規作成

## 審査との関係

- tasks スコープも sensitive。「使っていないスコープは要求しない」ポリシーがあるため、
  **タスク機能を実装してから審査を1回で出す**（先に審査→後からスコープ追加だと再審査）
- docs/google-verification.md の説明文・デモ動画にタスクの読み書きシーンを追加すること

## 実装順

日付レーン（AllDayOccurrence の UI 化）→ Tasks 読み取り同期 → 完了の書き戻し → 編集・作成。
Google 同期（カレンダー）の実 E2E が通ってから着手する。

## バックエンド実装 (2026-07-20、apps/sync)

Google Tasks API v1 との読み書きを既存の層構造 (google/\*.ts → core/\*.ts →
UserSyncDO の RPC → routes/api.ts) にそのまま合わせて実装した。DTO
(TaskListDTO/GoogleTaskDTO/TaskListsResponse/TasksSyncRequest/TasksSyncResponse/
TaskPatchRequest/TaskPatchResponse) は packages/shared/src/protocol.ts に既存。

- **スコープ**: `google/oauth.ts` の `OAUTH_SCOPES` に
  `https://www.googleapis.com/auth/tasks` を追加済み (`/auth/login` のリダイレクト先
  URL に `tasks` が含まれることを確認済み)。`hasRequiredScopes` には含めない (tasks は
  オプション機能)。新設の `hasTasksScope(grantedScope)` は判定ロジックを純関数として
  持つが、granted scope を D1 に永続化していないため実運用では未使用 — 実際の判定は
  「Google Tasks API を叩いて 403 が返るか」で行う最小実装。既存ユーザーは再連携
  (`/auth/login` をもう一度通す) で tasks 権限を得る。
- **GET /api/tasklists?accountId=**: `google/tasks.ts` の `fetchTaskLists` →
  `core/tasks.ts` の `listTaskLists` (401 リトライ1回) → `UserSyncDO.listTaskLists` RPC。
  Google が 403 を返したら `routes/api.ts` がそれを
  `{ error: 'tasks_scope_missing' }` (403) に変換して返す。ページングは実装していない
  (tasklists は通常数十件程度、design にもページング要件の記載なし)。
- **POST /api/tasks/sync**: `fetchTasksPage`
  (`showCompleted=true&showHidden=true&maxResults=100`) → `core/tasks.ts` の
  `syncTasks` が nextPageToken が無くなるまでページングして結合。Tasks API に
  syncToken は無いため常に全件取得 (`updatedMin` による差分ポーリングは未実装、
  将来やるならここに追加)。
- **POST /api/task/patch**: `patchTaskStatus` が `{ status }` のみを PATCH で送る。
  Google 側は completed 化時に `completed` (完了日時) を未指定でも自動補完する想定で
  実装した (`google/tasks.ts` にコメントで明記)。失敗は既存の書き戻し系
  (`/api/event/patch` 等) と同じく理由を問わず 409 `{ error: 'patch_failed' }` に一律
  マップする。
- テスト: `apps/sync/test/tasks.test.ts` (fetch 注入で tasklists 取得・ページング結合・
  401 リトライ・patch のリクエスト形状を検証) と `apps/sync/test/oauth.test.ts` の
  `hasTasksScope`/`OAUTH_SCOPES` ケースを追加。既存分含め 158 件全て pass、
  `wrangler dev` で3エンドポイントとも未認証 401・`/auth/login` のスコープに tasks
  が入ることを確認済み。
