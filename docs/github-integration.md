# GitHub 連携 設計メモ

Notion Calendar に無い差別化要素として GitHub をカレンダーの「第2のソース」にする。
2026-07-19 の設計判断を記録する。

## 基本方針

- 既存パイプラインをそのまま流用する:
  `GitHub API → Sync Worker → ローカル occurrence ストア → UI はローカルだけ読む`
- UI 層はソースをほぼ意識しない。occurrence に `source` と `link` を持たせるだけ。
- webhook はトリガーにすぎない（ペイロードを信用せず API に取りに行く）— Google の
  watch channel と同じ原則。webhook を張れないリポジトリはポーリング + ETag で代替。
- Projects v2 の date フィールドは GraphQL API でしか取れない点に注意。

## 載せるもの（全採用、実装はこの順）

| #   | 種別                                                    | 時間的性質   | 表示先                                    |
| --- | ------------------------------------------------------- | ------------ | ----------------------------------------- |
| 1   | issue/PR 期限・milestone・Projects v2 date              | 日付（期限） | 終日レーン                                |
| 2   | 作業キュー（review request / assigned issue / open PR） | 未定         | サイドレール → ドラッグでタイムブロック化 |
| 3   | 実績オーバーレイ（commit / PR / レビュー活動）          | 時刻イベント | グリッドに薄く重ねる                      |
| 4   | リリース予定・Actions 実行 / デプロイ                   | 混在         | タイムライン                              |

## 書き戻し

- **期限の変更まで**やる: milestone 期日・Projects v2 date をカレンダー上のドラッグで変更。
- 楽観的更新 + 失敗時ロールバックは Google 側の設計をそのまま流用。
- token は最初から fine-grained PAT / GitHub App を想定し、read 中心 + 必要最小限の write。

## 時間計測（アイデア、要設計）

「その issue / PR にどれだけ時間をかけたか」を計測できると面白い（ユーザー発案）。

- 作業キューからグリッドへドラッグしたタイムブロック = **予定**（planned）
- **実績**（actual）の候補は2系統:
  1. 手動タイマー（正確だが操作コスト）
  2. アクティビティ推定: commit / レビューイベントの時刻クラスタリングから推定（自動だが粗い）
- 予定 vs 実績を item 単位で突き合わせるレポートが最終形。
- 実装フェーズは GitHub 読み取り同期が安定してから。データモデルだけ先に考慮する
  （タイムブロックは `Occurrence.seriesId` とは別に `linkedItemId` を持つ想定）。

## データモデルへの布石（実装済み）

```ts
type OccurrenceSource = "local" | "google" | "github";
// Occurrence / AllDayOccurrence に source: OccurrenceSource と link?: { url, label? } を追加
```

## フェーズ配置

描画エンジン → IndexedDB → Google 同期（設計ドキュメントの順序）を崩さず、
GitHub 連携は Google 同期の**後**に同じ Worker 基盤へ追加する。
上表 1 → 2 → 3 → 4 の順で薄く積む。時間計測はその後。

## 認証プロバイダの抽象化 — `gh` CLI 対応（Tauri、2026-07-20 ユーザー要望）

一部の org は OAuth App / GitHub App のインストールを制限しており、連携（トークン取得）が
取りづらい。一方、開発者は手元で `gh auth login` 済みのことが多い。そこで **Tauri
デスクトップ版では `gh` コマンドをデータ取得の代替プロバイダにする**（認証が取りづらい
org 対策、ユーザー要望）。

- **プロバイダは2系統、DTO は共通**:
  - **Worker OAuth**（Web/PWA、現行）: `GET /api/github/{items,queue,activity}` が
    GitHub App user-to-server トークンで取得し DTO を返す。
  - **ローカル `gh`**（Tauri）: Tauri から `gh api <endpoint>` を invoke し、GitHub REST の
    生 JSON を**同じ DTO**（`GitHubItemDTO` / `GitHubWorkItemDTO` / `GitHubActivityDTO`）へ
    map する。Worker も OAuth トークンも不要で、ユーザーの既存 gh 認証をそのまま使う。
    ローカルファースト（正本=リモート、取得はデバイスから）とも合致。
- **クライアントの境界**: web 側の GitHub 取得を薄いプロバイダ interface の裏に置く
  （例 `GitHubProvider.fetchItems()/fetchQueue()/fetchActivity()`）。Web は fetch 実装、
  Tauri は `gh` 実装を注入。UI・ストア・マッピング（`sync/mapGitHub.ts` 等）は DTO だけを
  見るので無変更で差し替わる。
- **gh 実装の要点**（Tauri フェーズで実装）:
  - `gh api --paginate 'search/issues?q=...'`、`gh api 'repos/{o}/{r}/milestones?state=open'`、
    `gh api 'repos/{o}/{r}/commits?author=...&since=...'` 等、Worker 側 `github/*.ts` と
    同じエンドポイントを叩く。ページングは `--paginate`。
  - インストール先 repo の概念は gh には無い（gh はユーザーの全アクセス範囲）。対象 repo は
    設定で明示選択させる or `gh repo list` から選ぶ（Worker 版の installation スコープに相当）。
  - `gh` 未インストール/未ログインは検出してフォールバック（OAuth 連携を案内）。
  - Tauri の shell/command 権限（allowlist で `gh` のみ許可）で最小権限実行。
- **実装タイミング**: Tauri デスクトップ化のフェーズ（docs/multiplatform.md）。今の
  Web/OAuth 実装（①②③…）はそのまま「Worker プロバイダ」として残る。DTO を壊さないことが
  唯一の制約。
