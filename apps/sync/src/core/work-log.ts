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

export interface WorkLogInput {
  startIso: string;
  endIso: string;
  repo: string;
  branch?: string;
  issueRef?: string;
  agent?: string;
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
