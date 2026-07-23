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

import { isAccountInProfile } from "../accounts";

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

/** work_logs テーブルの1行。DB のカラム名 (snake_case) とは insertWorkLog が対応付ける。 */
export interface WorkLogRow {
  id: string;
  profileId: string;
  repo: string;
  issueRef?: string;
  branch?: string;
  agent?: string;
  startMs: number;
  endMs: number;
  createdAt: number;
}

export type WorkLogValidationError =
  | "missing_repo"
  | "invalid_start"
  | "invalid_end"
  | "start_not_before_end";

/**
 * 純関数。start<end・ISO パース可・repo 必須を検証する。routes/work-intervals.ts (400への
 * マッピング) と durable-object/mcp-agent.ts の log_work_interval ツールの両方が、
 * buildWorkLogRow を呼ぶ前にこれを呼んで検証する。
 */
export function validateWorkLogInput(input: {
  startIso: string;
  endIso: string;
  repo: string;
}): WorkLogValidationError | null {
  if (!input.repo || input.repo.trim().length === 0) return "missing_repo";
  const startMs = Date.parse(input.startIso);
  if (Number.isNaN(startMs)) return "invalid_start";
  const endMs = Date.parse(input.endIso);
  if (Number.isNaN(endMs)) return "invalid_end";
  if (startMs >= endMs) return "start_not_before_end";
  return null;
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
      row.endMs,
      row.createdAt,
    )
    .run();
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
 */
export async function updateWorkLog(
  env: Env,
  profileId: string,
  id: string,
  fields: WorkLogUpdateFields,
): Promise<"updated" | "not_found"> {
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
  await env.DB.prepare(`UPDATE work_logs SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
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
 */
export async function listWorkLogsForProfile(
  env: Env,
  profileId: string,
  sinceMs?: number,
  untilMs?: number,
): Promise<WorkLogListRow[]> {
  const conditions = ["profile_id = ?"];
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
 * 純関数。work_logs の行群を repo + issueRef でグルーピングし、区間長 (end_ms - start_ms) の
 * 合計と件数を集計する。MCP ツール work_summary から呼ばれる (docs/mcp.md「エージェントの
 * 作業時間記録」)。
 * - issueRef が null/undefined の行は捨てずに NO_ISSUE_LABEL の1グループへまとめる
 *   (repo だけの粒度でも実績を追えるようにするため)。
 * - start_ms >= end_ms の異常行は集計から除外する (count にも totalMs にも含めない)。
 *   validateWorkLogInput が挿入時点でこの条件を弾いているため通常は発生しないが、念のための
 *   防御。0 として加算する選択肢もあったが、「実績が無い区間」を「実績あり・0分」として
 *   count に混ぜるとクライアント側の平均時間計算等をミスリードするため、行ごと除外する方を選んだ。
 * - 並びは totalMs 降順。同着は repo → issueRef の文字列昇順で安定させる (テスト容易性のため)。
 */
export function aggregateWorkLogs(rows: WorkLogListRow[]): WorkLogSummaryItem[] {
  const buckets = new Map<string, WorkLogSummaryItem>();

  for (const row of rows) {
    if (row.start_ms >= row.end_ms) continue;
    const issueRef = row.issue_ref ?? NO_ISSUE_LABEL;
    const key = `${row.repo} ${issueRef}`;
    const durationMs = row.end_ms - row.start_ms;
    const existing = buckets.get(key);
    if (existing) {
      existing.totalMs += durationMs;
      existing.count += 1;
    } else {
      buckets.set(key, { repo: row.repo, issueRef, totalMs: durationMs, count: 1 });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => {
    if (b.totalMs !== a.totalMs) return b.totalMs - a.totalMs;
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.issueRef.localeCompare(b.issueRef);
  });
}

/**
 * "2h 15m" / "45m" 形式。apps/web/src/sync/timeTracking.ts の同名関数と実装は同一だが、
 * sync は web に依存していない (別 app、別 package.json) ためこちらに複製してある —
 * MCP ツール work_summary のレスポンスに人間可読な totalHm を添えるためだけの小さな
 * 純関数なので、workspace 越しの依存を増やすより複製の方が割に合う判断。
 */
export function formatDurationHm(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
