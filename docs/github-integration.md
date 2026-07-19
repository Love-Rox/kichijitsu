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

| # | 種別 | 時間的性質 | 表示先 |
|---|------|-----------|--------|
| 1 | issue/PR 期限・milestone・Projects v2 date | 日付（期限） | 終日レーン |
| 2 | 作業キュー（review request / assigned issue / open PR） | 未定 | サイドレール → ドラッグでタイムブロック化 |
| 3 | 実績オーバーレイ（commit / PR / レビュー活動） | 時刻イベント | グリッドに薄く重ねる |
| 4 | リリース予定・Actions 実行 / デプロイ | 混在 | タイムライン |

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
type OccurrenceSource = 'local' | 'google' | 'github'
// Occurrence / AllDayOccurrence に source: OccurrenceSource と link?: { url, label? } を追加
```

## フェーズ配置

描画エンジン → IndexedDB → Google 同期（設計ドキュメントの順序）を崩さず、
GitHub 連携は Google 同期の**後**に同じ Worker 基盤へ追加する。
上表 1 → 2 → 3 → 4 の順で薄く積む。時間計測はその後。
