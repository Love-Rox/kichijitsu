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

## 第3段階 実装メモ（2026-07-20: webhook/alarm → 実 Google 書き込みの配線）

トリガーは `ProfileHubDO.notifyChanged(accountId, calendarId, profileId)` 一箇所
（webhook 受信・UserSyncDO alarm ポーリングの両方がここへ来る）。SSE 配信後、
`ctx.waitUntil` でバックグラウンド実行することで SSE レスポンスを遅らせない。

- **オーケストレーション**: `apps/sync/src/core/block-orchestrate.ts` の
  `reconcileSourceChange`（副作用は全て `ReconcileDeps` 注入、モック deps で単体テスト
  — `test/block-orchestrate.test.ts`）。第2段階の `reconcileBlockRule` /
  `buildMirrorEventBody`（`core/block-reconcile.ts`）をそのまま再利用する。
- **適用順序と不整合防止**: ルールごとに全 source calendar のイベントを結合 →
  `reconcileBlockRule` で差分計算 → Google 書き込みが成功して初めて対応する
  `block_mirrors` 行を書く（create 失敗なら行を挿入しない、patch/delete 失敗なら
  行を更新/削除しない）。1操作・1ルールの失敗は他に波及させず `console.error` で継続する。
- **Google 書き込み系の新規ヘルパー**（3層構造 `google/*.ts` → `core/*.ts` → DO RPC を維持）:
  - `google/list-events.ts` + `core/list-events.ts`
    (`listEventsInWindowWithRetry`): `singleEvents=true&showDeleted=false&timeMin&timeMax&maxResults=250&orderBy=startTime`
    で `events.list` をページング取得。`extendedProperties` を DTO にマッピングするよう
    `core/google-events.ts` の `toGoogleEventDTO`/`RawGoogleEvent` を拡張（mirror 判定に必須）。
  - `google/insert-event.ts` + `core/insert-event.ts` (`insertEventWithRetry`): 既存
    `createEvent`（title/startMs/endMs 限定）とは別に、`MirrorEventBody`
    （extendedProperties/transparency/visibility/eventType 込み）をそのまま送る汎用版。
  - `google/patch-event-raw.ts` + `core/patch-event-raw.ts`
    (`patchEventRawWithRetry`): 既存 `patchEvent`（epoch ms + timeZone、時刻予定限定）とは
    別に、source の start/end (`dateTime`/`date` いずれも) をそのまま写す raw 版。
    all-day mirror の patch を正しく行うために追加した。delete は既存 `deleteEvent` RPC を
    そのまま流用（新規実装なし）。
  - `UserSyncDO` に `listEventsInWindow` / `createMirrorEvent` / `patchEventRaw` の3 RPC を追加。
- **ProfileHubDO 側の実 deps**: `block_rule_sources`/`block_rules` を profileId で絞って
  ルールを集約（`aggregateBlockRules` 再利用、profile 越境防止）、`block_mirrors` の
  CRUD、対象 `UserSyncDO` への RPC 呼び出し。ウィンドウは `[now-1日, now+60日]`。
- **`notifyChanged` のシグネチャ変更**: `profileId` を第3引数として明示的に渡すよう変更した
  （webhook route・`UserSyncDO.alarm()` の両呼び出し元を追従）。理由: `ProfileHubDO.profileId`
  は SSE 接続 (`fetch()`) 時にしか設定されず、ブラウザが一度も開かれていない状態で
  webhook が先に届くケースでは未設定のままだった。プロファイル越境防止のクエリに
  `profileId` が必須なため、これを補うために変更した。
- **ループ防止**: mirror は target カレンダーに `kichijitsuMirror=1` を付けて作られる。
  target が別ルールの source であっても、`reconcileBlockRule` が `isMirrorEvent` で
  mirror 自身を除外するため無限増殖しない（第2段階から継続する不変条件）。
- **並行性の既知の限界**: `ProfileHubDO` インスタンス内に `(accountId, calendarId)` ごとの
  Promise チェーン (`reconcileChains`) を持ち、同一対象への reconcile を直列化する簡易
  ロックを入れた。ただしこれは in-memory な状態であり、DO の再起動・退避 (eviction) を
  跨いでは保持されない。短時間に webhook とポーリングが競合するなど極端なケースまでは
  完全に防げず、完全な冪等性の保証は今回のスコープ外。
- **スコープ外（第4段階に持ち越し）**: outOfOffice の Workspace 判定・busy フォールバックは
  未実装。個人 Gmail アカウント等で Google が `eventType: 'outOfOffice'` を拒否した場合、
  `insertEventWithRetry` は `GoogleApiError` を投げ、呼び出し元が `console.error` で
  流すだけになる（busy への自動差し替えはしない）。

## ミラー予定の後始末（2026-07-28）

ルールが無くなっても、Google 側に作った mirror 予定（`kichijitsuMirror=1` 付きの
「予定あり」）は残り続ける、という問題への対応。

**原則: Google 上の予定を消すのは、利用者が明示的に選んだときだけ。**

| 経路 | Google の mirror 予定 | `block_mirrors` の行 |
| --- | --- | --- |
| ルール削除 `DELETE /api/block-rules` | `deleteMirrors:true` のときだけ削除（UI の確認は**既定チェック済み**） | 常に削除 |
| target 変更 `POST /api/block-rules` | **残す**（古い target の予定は孤児になる） | target が変わったら削除 |
| 連携解除 `DELETE /api/account`（**ルールごと消える**場合＝target を解除、または source を全部解除） | **残す**（選ぶ機会が無いため。target が生きていれば技術的には消せるが、対応表ごと消える以上これは「追従の続き」ではなく新しい破壊操作になる） | ルールごと削除 |
| 連携解除 `DELETE /api/account`（**ルールが生き残る**場合＝source の一部だけ解除） | **その source 由来のぶんは削除**（2026-07-31）。残った source からリコンサイルを起こす | 該当 source の参照だけ削除。`block_mirrors` はリコンサイルが処理する |

`a5d453a` の原則（Google 上の予定を消すのは利用者が明示的に選んだときだけ）と、
`6999fe8`（一部解除でミラーを片付ける）は矛盾しない。境目は **`block_mirrors` の行が
生き残るか**:

- **ルールが生き残る** → 対応表も残るので、放っておいても残った source が次に変わった
  時点で `reconcileBlockRule` が「source に居ない予定のミラー」として `toDelete` に載せる。
  つまりリコンサイルを起こすのは「消すか否か」ではなく **「いつ消えるか」だけ**を変えて
  いて、削除自体はルールを作った時点で選んだ「元の予定に追従する」の一部
- **ルールごと消える** → 対応表も消えて二度と辿れない。ここで消すのは追従の続きではなく
  新しい破壊操作で、しかも取り消せない。解除には「消しますか」を聞ける瞬間が無い

target 変更で旧 target のミラーを残すのも同じ理屈（旧 target のミラーは生きたルールの
管轄外に落ちる）。

### ルール削除

- リクエストは `BlockRuleDeleteRequest { id, deleteMirrors?: boolean }`。
  **省略時は `false`（消さない）** — 省略で届くのは旧クライアント・MCP・手書きの curl であり、
  そこへ「頼んでいない削除」を黙って走らせないため。判定は `core/block-rules.ts` の
  `resolveDeleteMirrors`（純関数）。
  UI 側は逆に既定チェック済みで、常に `true`/`false` を明示して送る
  （`apps/web/src/sync/blockRules.ts` の `buildBlockRuleDeleteRequest` は第2引数必須）。
- 削除の実体は `core/block-orchestrate.ts` の `deleteRuleMirrors`。
  「source が1件も無い状態へのリコンサイル」と同じなので、判断は既存の純関数
  `reconcileBlockRule([], mirrors)` の `toDelete` を使い、実行も通常のリコンサイルと同じ
  `applyMirrorDeletions` を通す（削除順序と best-effort の扱いを1箇所に保つ）。
- **best-effort**: 1件失敗しても残りを続け、失敗しても例外は投げない。ルール行の削除は必ず行う
  （「Google の予定が消せないせいでルールも消せない」状態に閉じ込めないため）。
  Google の削除に失敗した行だけは対応表から消さない（辿れない孤児を作らないため）。

### target 変更時の対応表の整理（404 バグの修正）

`block_mirrors` は `rule_id` で引くだけで「どのカレンダーの event か」を持たないため、
target を変えたまま行を残すと、**古い target に作った event id を新しい target に対して
patch/delete しにいって必ず 404 になる**（リコンサイルはルール単位で失敗し、新 target には
何も作られない）。POST の更新経路で `shouldDiscardMirrorRows`（`core/block-rules.ts` の純関数）が
true なら `block_mirrors` の行を捨てる。行が無くなれば次のリコンサイルが新 target に作り直す。
古い target に残った予定は消さない（上記の原則）。

回帰テスト: `test/block-rules-route.test.ts`（更新の batch に `DELETE FROM block_mirrors` が
含まれるか）と `test/block-orchestrate.test.ts` の「target 変更後のリコンサイル (404 回帰)」
（フェイク Google が未知の (calendar, event) に 404 を投げる）。
