# カレンダーブロック機能 設計メモ

2026-07-20 ユーザー要望: Notion Calendar の「他のカレンダーをブロック」相当。
あるカレンダーの予定がある時間帯を、別のカレンダー (別アカウント可) に
「予定あり (Busy)」として自動複製し、同僚などから見て空いていないようにする。

## 仕様

- **ブロックルール**: `{ ソース: (アカウント, カレンダー) の集合, ターゲット: (アカウント, カレンダー), モード }`
  を設定パネルで定義。プロファイル単位
- 複製されるのは**時間帯だけ**。タイトルは「予定あり」固定、詳細・場所・参加者は
  写さない (プライバシー原則。Notion Calendar と同じ)
- ソース予定の変更/削除に追従して Busy ブロックも更新/削除
- 自分が作った Busy ブロックは UI 上で薄く表示し、通常予定と区別する

## 不在 (Out of office) モード — Google Workspace

- モード選択: 「予定あり (busy)」/「**不在 (outOfOffice)**」
- 不在は Google Calendar API の `eventType: 'outOfOffice'` で作成。
  **Workspace アカウントの primary カレンダー限定**の機能で、会議の自動辞退
  (autoDeclineMode) も設定可能
- 個人 Gmail アカウントでは API が拒否するため、busy モードへフォールバックし
  UI にその旨を表示

## 実装方式（段階）

1. **第1段階: クライアント主導** — hello/changed の同期後に、ルールに基づき
   ソース予定とターゲットの Busy ブロックの差分を計算し、イベント作成/削除 API
   （フェーズ5の patch に加えて create/delete を追加実装）で反映。
   アプリを開いている間だけ追従する制約があるが、状態はすべてクライアント側で完結
2. **第2段階（必要になったら）: サーバー主導** — webhook 受信時にサーバーが差分反映。
   D1 に「ソースイベント ID → Busy イベント ID」の対応表を持つ（**ID と時刻のみ。
   予定の内容は保存しない** — サーバー無内容原則と両立）。アプリを閉じていても追従する

## 依存関係・実装タイミング

イベントの **create / delete API**（現状は patch のみ）が前提。
カスケード表示・同一予定集約 → 実書き戻し E2E の後に第1段階から着手する。

## 確定設計（2026-07-20 ユーザー決定: サーバー主導 + 不在モードも）

### ブロックルール（プロファイル単位、D1 保存）
- `block_rules(id, profile_id, source_account_id, source_calendar_id, target_account_id, target_calendar_id, mode, created_at)`
  - source は複数可（rule を複数行 or source を別テーブル）。target は1つ
  - `mode`: `'busy'` | `'outOfOffice'`
- 設定 API: `GET/POST/DELETE /api/block-rules`（requireAuth + source/target 双方の所属検証）

### 対応表（内容は保存しない原則を維持: ID と時刻のみ）
- `block_mirrors(rule_id, source_event_id, mirror_event_id, source_updated, created_at)`
  - ソース予定1件 → 生成した Busy/不在ブロック1件の対応。タイトルは固定「予定あり」、
    詳細・場所・参加者は写さない

### サーバー主導の追従
- **トリガー**: 既存の webhook 受信（/api/webhook/google）とポーリング（UserSyncDO alarm）。
  source カレンダーの changed を検知したら、その (account, calendar) を source に持つ
  block_rules を D1 で引き、**リコンサイル**を回す
- **リコンサイル**（UserSyncDO or 専用 DO）: source カレンダーの現予定集合を取得し、
  block_mirrors と突き合わせて差分適用:
  - source に新規 → target に Busy/不在を create（既存の event create API 内部利用）→ mirror 記録
  - source の時刻変更 → mirror の時刻を patch
  - source 削除/キャンセル → mirror を delete + 行削除
  - **無限ループ防止**: 生成した mirror 自体が別ルールの source にならないよう、
    mirror は専用の識別（extendedProperties.private.kichijitsuMirror=1 等）を付け、
    source 集合から除外する
- ブロック内容: `mode='busy'` は通常イベント（summary=「予定あり」、visibility=private、
  transparency=opaque）。`mode='outOfOffice'` は eventType='outOfOffice'（**Workspace の
  primary 限定**。個人 Gmail や非 primary は API 拒否 → busy にフォールバックし、UI に
  「このアカウントは不在に非対応のため予定ありにしました」を表示）

### 段階実装
1. block_rules の CRUD + 設定 UI（どの source をどの target に、busy/不在）
2. リコンサイル・ロジック（純関数: 現予定集合 × mirror → create/patch/delete 差分）+ テスト
3. webhook/alarm からリコンサイル起動、mirror の除外・ループ防止
4. outOfOffice モードと Workspace 判定・フォールバック
5. UI: 生成された Busy/不在ブロックは既存の Busy ハッチ表示で出る（自動生成と分かる印）
