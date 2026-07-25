/**
 * 作業実績記録機能 (docs/mcp.md「エージェントの作業時間記録」)。Claude Code 等の hook から
 * MCP ツール `log_work_interval` / REST `POST /api/work-intervals` の両方が呼ぶ共通コア。
 *
 * D1 保存 (2026-07-21移行): 当初はユーザーの Google カレンダー自身 (専用の「kichijitsu 実績」
 * カレンダー、無ければ自動作成) への書き込みだったが、カレンダー新規作成には calendar.events
 * では足りず 403 (scope 不足) になる実バグが本番で判明したため、work_logs テーブルへの D1 保存に
 * 切り替えた。work-log は Google に正本が無いアプリ固有データなので、「サーバーは Google イベント
 * 本体を持たない」原則には反しない。
 */

import type { OpenWorkIntervalDTO, WorkLogValidationError } from "@kichijitsu/shared";
import { aggregateWorkLogEntries, validateWorkLogInterval } from "@kichijitsu/shared";
import { isAccountInProfile } from "../accounts";

/**
 * "2h 15m" / "45m" 形式。以前は apps/web/src/sync/timeTracking.ts と**バイト単位で同一の複製**を
 * ここに置いていた (「sync は web に依存していないため複製」) が、2026-07-25 に共通の置き場
 * (@kichijitsu/shared の work-log.ts) を作って寄せた。既存の呼び出し側 (durable-object/
 * mcp-agent.ts の work_summary) の import 元を変えずに済むよう、ここから再エクスポートする。
 */
export { formatDurationHm } from "@kichijitsu/shared";

/**
 * 入力検証のエラー。実体は shared (work-log.ts の WorkLogValidationError) — web の手動追加フォーム
 * (sync/workLogEntry.ts) と同じ4値を二重定義していたのを 2026-07-25 に寄せた。既存の import 元を
 * 変えないための別名再エクスポート。
 */
export type { WorkLogValidationError } from "@kichijitsu/shared";

export interface WorkLogInput {
  startIso: string;
  endIso: string;
  repo: string;
  branch?: string;
  issueRef?: string;
  agent?: string;
}

/**
 * 純関数。手動記録 (POST /api/work-logs) の agent 既定値解決。空文字/未指定/空白のみは
 * "manual" に正規化する。hook 経由 (POST /api/work-intervals) は常に具体的な値
 * (例: "claude-code") を送ってくる想定でこの関数を通さず buildWorkLogRow にそのまま渡すため、
 * "manual" は事実上「手動フォームから来た」ことの目印として機能する
 * (apps/web/src/sync/workLogEntry.ts の isManualWorkLog がこの値を見て hook 記録と区別する)。
 */
export function resolveManualWorkLogAgent(agent?: string): string {
  return agent && agent.trim().length > 0 ? agent.trim() : "manual";
}

/**
 * work_logs テーブルの1行。DB のカラム名 (snake_case) とは insertWorkLog が対応付ける。
 * endMs は number | null — null = 開始済み・未停止 (実行中) の開区間 (0011 で end_ms を
 * NULL 許容に変更、startWorkInterval が null で挿入する)。完了区間の挿入経路 (buildWorkLogRow)
 * は常に number を入れる。
 */
export interface WorkLogRow {
  id: string;
  profileId: string;
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  startMs: number;
  endMs: number | null;
  createdAt: number;
}

/**
 * 純関数。start<end・ISO パース可・repo 必須を検証する。routes/work-intervals.ts (400への
 * マッピング) と durable-object/mcp-agent.ts の log_work_interval ツールの両方が、
 * buildWorkLogRow を呼ぶ前にこれを呼んで検証する。
 *
 * 判定本体は shared の validateWorkLogInterval (web の手動追加フォームと共通、2026-07-25)。
 * ここに残るのは「ISO 文字列 → epoch ms」の変換だけ — web 側は同じ検証を datetime-local の
 * 壁時計値 (Temporal で解釈) に対して行うため、文字列の解釈は各々に残す設計にした。
 * 判定順 (repo → start → end → 前後関係) と返るエラーコードは移設前と同じ。
 */
export function validateWorkLogInput(input: {
  startIso: string;
  endIso: string;
  repo: string;
}): WorkLogValidationError | null {
  return validateWorkLogInterval({
    repo: input.repo,
    startMs: Date.parse(input.startIso),
    endMs: Date.parse(input.endIso),
  });
}

/**
 * 純関数。WorkLogInput から work_logs の1行を組み立てる。id/now は呼び出し側 (ルート/MCP ツール)
 * が crypto.randomUUID()/Date.now() で採番して渡す (副作用をこの関数に持ち込まないため)。
 * start<end 等の検証は事前に validateWorkLogInput を呼んでいる前提でここでは検証しない。
 */
export function buildWorkLogRow(
  id: string,
  profileId: string,
  input: WorkLogInput,
  now: number,
): WorkLogRow {
  return {
    id,
    profileId,
    repo: input.repo,
    issueRef: input.issueRef,
    branch: input.branch,
    agent: input.agent,
    startMs: Date.parse(input.startIso),
    endMs: Date.parse(input.endIso),
    createdAt: now,
  };
}

/**
 * work_logs への INSERT。D1 に直接触れるため、mcp-auth.ts/mcp-calendars.ts と同じ理由
 * (「D1 のモックをこのリポジトリに新規導入するほどの価値は無い」) で単体テストは書かない。
 */
export async function insertWorkLog(env: Env, row: WorkLogRow): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO work_logs (id, profile_id, repo, issue_ref, branch, agent, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      row.id,
      row.profileId,
      row.repo,
      row.issueRef ?? null,
      row.branch ?? null,
      row.agent ?? null,
      row.startMs,
      // 開区間 (実行中) は endMs = null をそのまま NULL として bind する (startWorkInterval 経由)。
      row.endMs ?? null,
      row.createdAt,
    )
    .run();
}

/** D1 (SQLite) がユニーク制約違反を報告するときのメッセージ断片。 */
const UNIQUE_CONSTRAINT_MARKER = "UNIQUE constraint failed";

/** isUniqueConstraintError 用に、エラー的な値からメッセージ文字列を取り出す (取れなければ空文字)。 */
function errorMessageOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return "";
}

/**
 * 純関数。D1 の書き込み例外が「ユニーク制約違反」かを判定する述語。
 *
 * D1/SQLite にはエラーコード (SQLITE_CONSTRAINT_UNIQUE 等) を型として取り出す API が無く、
 * Workers の D1 バインディングは `D1_ERROR: UNIQUE constraint failed: ...` の形の Error を
 * 投げてくるだけなので、メッセージ断片で判定するしかない。判定をここに切り出しておくのは
 * (1) 呼び出し側 (startWorkInterval / updateWorkLog) が「制約違反だけを吸収して他は再 throw」を
 * 取り違えないようにするため、(2) D1 のモックを入れずに単体テストできるようにするため。
 * 実装によっては元の SQLite エラーが `cause` に包まれるため、1段だけ cause も見る。
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (errorMessageOf(err).includes(UNIQUE_CONSTRAINT_MARKER)) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return errorMessageOf(cause).includes(UNIQUE_CONSTRAINT_MARKER);
}

/**
 * work_logs の1件削除 (手動記録の訂正用、DELETE /api/work-logs/:id)。id が存在しない、または
 * 別プロファイルの行なら削除せず "not_found" を返す (「無い id」と「他人の id」を区別しない —
 * routes/api.ts の他の DELETE 系 (block-rules/mcp-tokens) と同じ、存在有無を漏らさない方針)。
 * 所有チェックは accounts.ts の isAccountInProfile を再利用する (work_logs も他テーブルと同じ
 * `{ profile_id }` 形の行を返すため、汎用の述語がそのまま使える)。
 * insertWorkLog と同じ理由 (D1 のモックをこのリポジトリに新規導入するほどの価値は無い) で
 * D1 呼び出し自体の単体テストは書かない — 所有チェックの分岐は isAccountInProfile 側のテスト
 * (test/accounts.test.ts) でカバーされている。
 */
export async function deleteWorkLog(
  env: Env,
  profileId: string,
  id: string,
): Promise<"deleted" | "not_found"> {
  const existing = await env.DB.prepare("SELECT profile_id FROM work_logs WHERE id = ?")
    .bind(id)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(existing, profileId)) {
    return "not_found";
  }
  await env.DB.prepare("DELETE FROM work_logs WHERE id = ?").bind(id).run();
  return "deleted";
}

/**
 * updateWorkLog の部分更新入力。全フィールド任意 = 定義されているキーだけを更新する
 * (未指定は現状維持)。start/end は WorkLogInput と同じ ISO 文字列で受け取り、
 * buildWorkLogUpdate が Date.parse で epoch ms に変換する。
 */
export interface WorkLogUpdateFields {
  startIso?: string;
  endIso?: string;
  repo?: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
}

/**
 * 純関数。部分更新入力から work_logs の UPDATE ... SET 節を組み立てる。定義済みのキーだけを
 * assignments/values に積むので、渡された分だけの部分更新になる (未指定キーは触らない)。
 * start/end は insertWorkLog/buildWorkLogRow と同じく Date.parse で epoch ms に変換する。
 * カラム名対応 (issueRef → issue_ref 等) はここに一元化する。
 * D1 に触れない純ロジックなので単体テスト対象 (updateWorkLog 本体は D1 直接なのでテストしない、
 * insertWorkLog/deleteWorkLog と同じ理由)。
 */
export function buildWorkLogUpdate(fields: WorkLogUpdateFields): {
  assignments: string[];
  values: (string | number)[];
} {
  const assignments: string[] = [];
  const values: (string | number)[] = [];
  if (fields.startIso !== undefined) {
    assignments.push("start_ms = ?");
    values.push(Date.parse(fields.startIso));
  }
  if (fields.endIso !== undefined) {
    assignments.push("end_ms = ?");
    values.push(Date.parse(fields.endIso));
  }
  if (fields.repo !== undefined) {
    assignments.push("repo = ?");
    values.push(fields.repo);
  }
  if (fields.issueRef !== undefined) {
    assignments.push("issue_ref = ?");
    values.push(fields.issueRef);
  }
  if (fields.branch !== undefined) {
    assignments.push("branch = ?");
    values.push(fields.branch);
  }
  if (fields.agent !== undefined) {
    assignments.push("agent = ?");
    values.push(fields.agent);
  }
  return { assignments, values };
}

/**
 * work_logs の1件部分更新 (手動記録の後追い訂正用、PATCH /api/work-logs/:id)。deleteWorkLog と
 * 同じく、まず所有チェック (SELECT profile_id → isAccountInProfile) を行い、別プロファイル/存在
 * しない id は更新せず "not_found" を返す (「無い id」と「他人の id」を区別しない方針も DELETE と
 * 同じ)。所有 OK なら渡された fields のうち定義済みのキーだけを UPDATE する (部分更新)。更新対象が
 * 無ければ D1 を触らず現状維持で "updated" (成功扱い) を返す。start/end の妥当性検証 (ISO パース・
 * start<end 等) は呼び出し側 (routes/api.ts) が事前に行う前提でここでは検証しない
 * (validateWorkLogInput を通した後に呼ばれる、buildWorkLogRow と同じ役割分担)。
 * insertWorkLog/deleteWorkLog と同じ理由 (D1 のモックを新規導入しない) で D1 呼び出し本体の
 * 単体テストは書かない — SET 節の組み立ては純関数 buildWorkLogUpdate に切り出してテストする。
 *
 * 実行中 (end_ms IS NULL) の行に対する PATCH の扱い (2026-07-25):
 * この関数は対象行が開区間かどうかを見ない = 実行中の行も同じ経路で部分更新できる。ただし
 * repo/issueRef を変えると 0011 の部分ユニークインデックス idx_work_logs_open
 * (profile_id, repo, COALESCE(issue_ref,'')) WHERE end_ms IS NULL に衝突し得る (変更先のキーで
 * 既に別の開区間が走っている場合)。以前はこの違反が未処理例外になり app.onError 経由で 500 に
 * なっていたため、ユニーク制約違反だけを捕まえて "conflict" を返し、呼び出し側 (routes/api.ts)
 * が 409 work_log_conflict にマッピングする。制約違反以外の例外は握り潰さず再 throw する。
 * なお「start 片方だけの更新で区間が反転し得る」点は routes/api.ts のコメントにある通り意図的な
 * 現状維持 (集計側 aggregateWorkLogs が start_ms >= end_ms の行を除外して防御している)。
 */
export async function updateWorkLog(
  env: Env,
  profileId: string,
  id: string,
  fields: WorkLogUpdateFields,
): Promise<"updated" | "not_found" | "conflict"> {
  const existing = await env.DB.prepare("SELECT profile_id FROM work_logs WHERE id = ?")
    .bind(id)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(existing, profileId)) {
    return "not_found";
  }
  const { assignments, values } = buildWorkLogUpdate(fields);
  if (assignments.length === 0) {
    return "updated";
  }
  try {
    await env.DB.prepare(`UPDATE work_logs SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  } catch (err) {
    // 開区間の一意制約に当たった = 変更先のキーで既に実行中の区間がある (上のコメント参照)。
    // それ以外の失敗は隠さず上へ投げる (500 のままにする)。
    if (!isUniqueConstraintError(err)) throw err;
    return "conflict";
  }
  return "updated";
}

/**
 * work_logs の SELECT 結果1行 (DB のカラム名 = snake_case のまま)。書き込み用の WorkLogRow
 * (camelCase、insertWorkLog が使う) とは別の型にしてある — SELECT 結果をそのまま INSERT に
 * 渡せてしまうような取り違えを型で防ぐため。
 */
export interface WorkLogListRow {
  id: string;
  repo: string;
  issue_ref: string | null;
  branch: string | null;
  agent: string | null;
  start_ms: number;
  end_ms: number;
}

/**
 * work_logs の読み取り共通ヘルパー。元々 routes/api.ts の GET /api/work-logs に直書きされて
 * いた SELECT を切り出したもの (2026-07-21、MCP ツール work_summary 追加にあたり REST と共有
 * するため)。profileId でスコープし、sinceMs/untilMs (epoch ms、任意) で start_ms/end_ms を
 * 絞り込む。新しい順・上限500件は元の実装の挙動をそのまま踏襲 (変更していない)。
 * D1 に直接触れるため、insertWorkLog と同じ理由で単体テストは書かない。
 *
 * end_ms IS NOT NULL の確定済み行のみ返す (0011 の開区間対応、2026-07-23)。実行中 (end_ms IS
 * NULL) の開区間は listOpenWorkIntervals で別途扱うため、ここでは除外する — これにより既存の
 * 呼び出し側 (GET /api/work-logs → WorkLogDTO、MCP work_summary の集計) は無変更のまま、
 * 開始中が混ざらない (WorkLogListRow.end_ms を number のまま扱える)。
 */
export async function listWorkLogsForProfile(
  env: Env,
  profileId: string,
  sinceMs?: number,
  untilMs?: number,
): Promise<WorkLogListRow[]> {
  const conditions = ["profile_id = ?", "end_ms IS NOT NULL"];
  const params: (string | number)[] = [profileId];
  if (sinceMs !== undefined) {
    conditions.push("start_ms >= ?");
    params.push(sinceMs);
  }
  if (untilMs !== undefined) {
    conditions.push("end_ms <= ?");
    params.push(untilMs);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, repo, issue_ref, branch, agent, start_ms, end_ms FROM work_logs WHERE ${conditions.join(" AND ")} ORDER BY start_ms DESC LIMIT 500`,
  )
    .bind(...params)
    .all<WorkLogListRow>();
  return results;
}

/** aggregateWorkLogs が issueRef の無い行をまとめるグループのラベル。 */
export const NO_ISSUE_LABEL = "(no issue)";

/** repo + issueRef でグルーピングした集計1件 (MCP ツール work_summary の戻り値の単位)。 */
export interface WorkLogSummaryItem {
  repo: string;
  /** issue_ref が無い行は NO_ISSUE_LABEL にまとめる (null のまま返すとクライアント側の
   * グルーピングキー生成が面倒になるため、文字列に正規化して返す)。 */
  issueRef: string;
  totalMs: number;
  count: number;
}

/**
 * 純関数。work_logs の行群を issue 単位でグルーピングし、区間長 (end_ms - start_ms) の合計と
 * 件数を集計する。MCP ツール work_summary から呼ばれる (docs/mcp.md「エージェントの作業時間記録」)。
 *
 * グルーピングと合計の定義は shared の aggregateWorkLogEntries に寄せた (2026-07-25)。ここに残るのは
 * 「行 (snake_case) → 集計入力への詰め替え」と「MCP レスポンスの見せ方」だけ:
 * - issueRef が null/undefined の行は捨てずに NO_ISSUE_LABEL の1グループへまとめる
 *   (repo だけの粒度でも実績を追えるようにするため)。ラベル文字列は MCP 応答の表示都合なので
 *   shared には持たせずここで付ける (web 側は同じグループを issueRef undefined のまま扱う)。
 * - start_ms >= end_ms の異常行は集計から除外する (count にも totalMs にも含めない — 理由は
 *   shared 側のコメント参照)。全行が異常なグループは count === 0 になるので、ここで落として
 *   「グループごと出さない」従来の挙動を保つ。
 * - 並びは totalMs 降順。同着は repo → issueRef の文字列昇順で安定させる (テスト容易性のため)。
 *
 * **web の実績履歴との整合 (2026-07-25、リファクタリング フェーズ4)**: 以前はここが issue_ref の
 * 生文字列でグルーピングしていたため、hook が完全参照 (`owner/repo#12`) で記録した実績と UI
 * タイマー/手動入力由来の素の番号 (`12`) が別グループに割れ、web の実績履歴
 * (sync/workLogGrouping.ts の groupWorkLogsByIssue) と数字が食い違っていた。shared の
 * workLogIssueIdentity で正規化するようにしたので、完全参照の行では repo が「issue の所属 repo」、
 * issueRef が「番号のみ」になる (MCP 応答の見え方はその分変わる — 集計の定義を1つにするための
 * 意図的な変更)。
 */
export function aggregateWorkLogs(rows: WorkLogListRow[]): WorkLogSummaryItem[] {
  const buckets = aggregateWorkLogEntries(
    rows.map((row) => ({
      repo: row.repo,
      issueRef: row.issue_ref ?? undefined,
      startMs: row.start_ms,
      endMs: row.end_ms,
    })),
  );

  return buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({
      repo: bucket.repo,
      issueRef: bucket.issueRef ?? NO_ISSUE_LABEL,
      totalMs: bucket.totalMs,
      count: bucket.count,
    }))
    .sort((a, b) => {
      if (b.totalMs !== a.totalMs) return b.totalMs - a.totalMs;
      if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
      return a.issueRef.localeCompare(b.issueRef);
    });
}

// ---------------------------------------------------------------------------
// 開区間 (実行中) 対応 (docs/mcp.md「エージェントの作業時間記録」、0011、2026-07-23)。
// 開始と停止を別々に記録する経路。開始 = end_ms IS NULL の行を1本立てる、停止 = その行に
// end_ms を書き込む。従来の buildWorkLogRow/insertWorkLog (完了区間を一度に記録) は残す。
// ---------------------------------------------------------------------------

/**
 * 開区間の最小長 (ms)。apps/web の stopTimer (sync/timeTracking.ts) の MIN_DURATION_MS と揃える —
 * 停止時に end < start + この値 なら start + この値 にクランプし、誤操作の 0分/負の記録を防ぐ。
 */
export const MIN_WORK_INTERVAL_MS = 60_000;

/**
 * 未停止の開区間を cron が自動クローズするまでの上限区間長 (12時間)。閾値超えの開区間は
 * end_ms = start_ms + この値 に丸めて閉じる (autoCloseStaleOpenIntervals)。定数の適用は
 * scheduled ハンドラ (index.ts) が capMs 引数として渡す。
 */
export const AUTO_CLOSE_CAP_MS = 12 * 60 * 60 * 1000;

/**
 * 純関数。一意キー用に issueRef を正規化する。未指定/undefined は空文字にまとめる — DB 側の
 * 部分ユニークインデックス idx_work_logs_open が COALESCE(issue_ref, '') でキーを作るのと揃え、
 * 「issue_ref NULL」と「issue_ref 空文字」を同じ開区間キーとして扱うため。
 */
export function openIntervalIssueRefKey(issueRef?: string): string {
  return issueRef ?? "";
}

/**
 * 純関数。停止時の end を最小区間長でクランプする。end < start + MIN_WORK_INTERVAL_MS なら
 * start + MIN_WORK_INTERVAL_MS を返す (apps/web の stopTimer と同じ、誤操作の 0分/負の記録防止)。
 */
export function clampIntervalEnd(startMs: number, endMs: number): number {
  return Math.max(endMs, startMs + MIN_WORK_INTERVAL_MS);
}

export type WorkIntervalStartValidationError = "missing_repo" | "invalid_start";

/**
 * 純関数。開始入力の検証。repo 必須。startIso は任意 (省略時サーバー now) だが、来たら ISO として
 * パース可能であること。validateWorkLogInput の repo/start 検証を開区間用に切り出したもの。
 */
export function validateWorkIntervalStart(input: {
  repo: string;
  startIso?: string;
}): WorkIntervalStartValidationError | null {
  if (!input.repo || input.repo.trim().length === 0) return "missing_repo";
  if (input.startIso !== undefined && Number.isNaN(Date.parse(input.startIso))) {
    return "invalid_start";
  }
  return null;
}

export type WorkIntervalStopValidationError = "missing_repo" | "invalid_end";

/**
 * 純関数。停止入力の検証。repo 必須。endIso は任意 (省略時サーバー now) だが、来たら ISO として
 * パース可能であること。
 */
export function validateWorkIntervalStop(input: {
  repo: string;
  endIso?: string;
}): WorkIntervalStopValidationError | null {
  if (!input.repo || input.repo.trim().length === 0) return "missing_repo";
  if (input.endIso !== undefined && Number.isNaN(Date.parse(input.endIso))) {
    return "invalid_end";
  }
  return null;
}

/** 開始 (startWorkInterval) の入力。start は ISO (省略時サーバー now)。 */
export interface WorkIntervalStartInput {
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  startIso?: string;
}

/** 停止 (stopWorkInterval) の入力。end は ISO (省略時サーバー now)。 */
export interface WorkIntervalStopInput {
  repo: string;
  issueRef?: string;
  endIso?: string;
}

/**
 * 開区間 (end_ms IS NULL) の SELECT 結果1行 (DB のカラム名 = snake_case)。end_ms は持たない
 * (実行中なので常に NULL)。
 */
export interface OpenWorkIntervalListRow {
  id: string;
  repo: string;
  issue_ref: string | null;
  branch: string | null;
  agent: string | null;
  start_ms: number;
}

/**
 * 純関数。開区間の1行を OpenWorkIntervalDTO に変換する。issueRef/branch/agent は値があるときだけ
 * 積む (WorkLogDTO のマッピングと同じ流儀)。end は持たない (実行中)。
 */
export function buildOpenWorkIntervalDTO(row: OpenWorkIntervalListRow): OpenWorkIntervalDTO {
  return {
    id: row.id,
    repo: row.repo,
    ...(row.issue_ref ? { issueRef: row.issue_ref } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    startMs: row.start_ms,
  };
}

/**
 * 開区間 (end_ms IS NULL) の id を1件引く。無ければ null。startWorkInterval が「事前チェック」と
 * 「INSERT がユニーク制約違反したときの引き直し」の2箇所で同じ条件を使うため切り出してある。
 * issueRefKey は openIntervalIssueRefKey で正規化済みの値を渡す (DB 側の COALESCE(issue_ref,'') と揃える)。
 */
async function selectOpenIntervalId(
  env: Env,
  profileId: string,
  repo: string,
  issueRefKey: string,
): Promise<string | null> {
  const existing = await env.DB.prepare(
    "SELECT id FROM work_logs WHERE profile_id = ? AND repo = ? AND COALESCE(issue_ref, '') = ? AND end_ms IS NULL LIMIT 1",
  )
    .bind(profileId, repo, issueRefKey)
    .first<{ id: string }>();
  return existing ? existing.id : null;
}

/**
 * 開始。同一 (profileId, repo, issueRef) の開区間 (end_ms IS NULL) が既にあれば no-op で
 * { id, alreadyOpen: true } を返す (二重 start の防御 — DB の部分ユニークインデックスとも整合)。
 * 無ければ end_ms = NULL の行を1本立てて { id, alreadyOpen: false }。start_ms は startIso があれば
 * その epoch ms、無ければ now。issueRef の一致は COALESCE(issue_ref, '') で NULL/空文字を同一視する
 * (openIntervalIssueRefKey と揃える)。start/repo の検証は呼び出し側が validateWorkIntervalStart で
 * 事前に済ませる前提 (buildWorkLogRow と同じ役割分担)。D1 直呼びのため insertWorkLog と同じ理由で
 * 本体の単体テストは書かない — 検証・キー正規化・DTO 変換・エラー判定の純ロジックは別関数でテストする。
 *
 * 二重 start の競合について (2026-07-25):
 * 事前の SELECT → INSERT は原子的ではないため、▶ の素早い二度押しや hook の再送で2本同時に
 * 走ると両方が SELECT で「開区間なし」を見てから INSERT に進む (web 側のガードは往復完了まで
 * 更新されない state を見るので通り抜ける)。負けた側は 0011 の部分ユニークインデックス
 * idx_work_logs_open に弾かれるが、以前はそれが未処理例外になり app.onError 経由で 500 を返して
 * いた (hook 経路 POST /api/work-intervals/start では Claude Code に 500 が見える)。そこで INSERT を
 * try/catch し、ユニーク制約違反なら「既に開始中」= 勝った側の行を引き直して alreadyOpen: true を
 * 返す。DB がキーの一意性を保証しているので、この扱いは事前 SELECT でヒットした場合と同じ意味になる。
 */
export async function startWorkInterval(
  env: Env,
  profileId: string,
  input: WorkIntervalStartInput,
): Promise<{ id: string; alreadyOpen: boolean }> {
  const key = openIntervalIssueRefKey(input.issueRef);
  const existingId = await selectOpenIntervalId(env, profileId, input.repo, key);
  if (existingId) {
    return { id: existingId, alreadyOpen: true };
  }

  const now = Date.now();
  const startMs = input.startIso !== undefined ? Date.parse(input.startIso) : now;
  const row: WorkLogRow = {
    id: crypto.randomUUID(),
    profileId,
    repo: input.repo,
    issueRef: input.issueRef,
    branch: input.branch,
    agent: input.agent,
    startMs,
    endMs: null,
    createdAt: now,
  };
  try {
    await insertWorkLog(env, row);
  } catch (err) {
    // ユニーク制約違反以外 (D1 の一時障害など) は握り潰さず上へ投げる (500 のままにする)。
    if (!isUniqueConstraintError(err)) throw err;
    const raced = await selectOpenIntervalId(env, profileId, input.repo, key);
    // 競合相手の開区間が引けないケース (INSERT 失敗の直後に相手が stop した等) は、
    // 「開始できたのか」を答えられないのでエラーとして扱う (嘘の id を返さない)。
    if (!raced) throw err;
    return { id: raced, alreadyOpen: true };
  }
  return { id: row.id, alreadyOpen: false };
}

/**
 * 停止。同一 (profileId, repo, issueRef) の開区間 (end_ms IS NULL) を探し、無ければ孤立停止として
 * 何も作らず { closed: false, reason: "no_open_interval" } を返す (誤った 0分記録を作らない)。あれば
 * その行の end_ms を endIso (無ければ now) の epoch ms で更新する。end は clampIntervalEnd で最小
 * 区間長にクランプする (誤操作の 0分/負の記録防止、apps/web stopTimer と同じ)。end/repo の検証は
 * 呼び出し側が validateWorkIntervalStop で事前に済ませる前提。D1 直呼びのため本体の単体テストは
 * 書かない (insertWorkLog と同じ理由)。
 */
export async function stopWorkInterval(
  env: Env,
  profileId: string,
  input: WorkIntervalStopInput,
): Promise<{ closed: boolean; id?: string; reason?: string }> {
  const key = openIntervalIssueRefKey(input.issueRef);
  const existing = await env.DB.prepare(
    "SELECT id, start_ms FROM work_logs WHERE profile_id = ? AND repo = ? AND COALESCE(issue_ref, '') = ? AND end_ms IS NULL LIMIT 1",
  )
    .bind(profileId, input.repo, key)
    .first<{ id: string; start_ms: number }>();
  if (!existing) {
    return { closed: false, reason: "no_open_interval" };
  }

  const now = Date.now();
  const endMs = input.endIso !== undefined ? Date.parse(input.endIso) : now;
  const clamped = clampIntervalEnd(existing.start_ms, endMs);
  await env.DB.prepare("UPDATE work_logs SET end_ms = ? WHERE id = ?")
    .bind(clamped, existing.id)
    .run();
  return { closed: true, id: existing.id };
}

/**
 * 開区間 (end_ms IS NULL) の一覧。profileId でスコープし、新しい順で返す。GET /api/work-logs/open が
 * OpenWorkIntervalsResponse として返す。確定済み (listWorkLogsForProfile) とは別経路 — 実行中は
 * WorkLogDTO に混ぜない (endMs: number を保つ)。D1 直呼びのため本体の単体テストは書かない
 * (行→DTO 変換は純関数 buildOpenWorkIntervalDTO でテストする)。
 */
export async function listOpenWorkIntervals(
  env: Env,
  profileId: string,
): Promise<OpenWorkIntervalDTO[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, repo, issue_ref, branch, agent, start_ms FROM work_logs WHERE profile_id = ? AND end_ms IS NULL ORDER BY start_ms DESC",
  )
    .bind(profileId)
    .all<OpenWorkIntervalListRow>();
  return results.map(buildOpenWorkIntervalDTO);
}

/**
 * 未停止で放置された開区間 (end_ms IS NULL かつ start_ms < nowMs - capMs) を自動クローズする。
 * end_ms = start_ms + capMs に丸めて区間長を上限で切り (実行中を無限に延ばさない)、閉じた件数を
 * 返す。cron (scheduled ハンドラ) が nowMs=Date.now()・capMs=AUTO_CLOSE_CAP_MS で呼ぶ。D1 直呼び
 * のため本体の単体テストは書かない (insertWorkLog と同じ理由)。
 */
export async function autoCloseStaleOpenIntervals(
  env: Env,
  nowMs: number,
  capMs: number,
): Promise<number> {
  const threshold = nowMs - capMs;
  const result = await env.DB.prepare(
    "UPDATE work_logs SET end_ms = start_ms + ? WHERE end_ms IS NULL AND start_ms < ?",
  )
    .bind(capMs, threshold)
    .run();
  return result.meta.changes ?? 0;
}
