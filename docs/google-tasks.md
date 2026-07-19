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
