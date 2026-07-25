/**
 * 作業実績 (work_logs) の `/api/work-logs*` ルート (docs/mcp.md「エージェントの作業時間記録」)。
 * routes/api.ts から分割 (2026-07-25) — 挙動は変えていない。
 *
 * **すべてセッション cookie 認証 (requireAuth) の web 用経路**。hook 用の同等機能
 * (POST /api/work-intervals・/start・/stop) は MCP トークンの Bearer 認証で routes/work-intervals.ts
 * にあり、認証経路が違うだけで同じ core/work-log.ts を呼ぶ — 片方を直すときは両方を見ること。
 */
import { Hono } from "hono";
import type {
  ApiError,
  OpenWorkIntervalsResponse,
  WorkIntervalStartRequest,
  WorkIntervalStartResponse,
  WorkIntervalStopRequest,
  WorkIntervalStopResponse,
  WorkLogCreateRequest,
  WorkLogCreateResponse,
  WorkLogDTO,
  WorkLogsResponse,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import {
  buildWorkLogRow,
  deleteWorkLog,
  insertWorkLog,
  listOpenWorkIntervals,
  listWorkLogsForProfile,
  resolveManualWorkLogAgent,
  startWorkInterval,
  stopWorkInterval,
  updateWorkLog,
  validateWorkIntervalStart,
  validateWorkIntervalStop,
  validateWorkLogInput,
} from "../core/work-log";

export const workLogsRoutes = new Hono<AppEnv>();

// 作業実績記録 (docs/mcp.md「エージェントの作業時間記録」、2026-07-21 D1 保存へ移行) の閲覧経路。
// 書き込み (POST /api/work-intervals, routes/work-intervals.ts) は MCP トークンの Bearer 認証だが、
// こちらは web 用でセッション cookie 認証 (requireAuth) — 認証経路が異なる点に注意。
// since/until (epoch ms の文字列、任意) で start_ms/end_ms を絞り込める。件数上限は新しい順 500件。
// SELECT 本体は core/work-log.ts の listWorkLogsForProfile に切り出してある (MCP ツール
// work_summary と共有するため、2026-07-21) — 挙動 (絞り込み条件・並び・上限) は変えていない。
workLogsRoutes.get("/api/work-logs", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const since = c.req.query("since");
  const sinceMs = since && !Number.isNaN(Number(since)) ? Number(since) : undefined;
  const until = c.req.query("until");
  const untilMs = until && !Number.isNaN(Number(until)) ? Number(until) : undefined;

  const results = await listWorkLogsForProfile(c.env, profileId, sinceMs, untilMs);

  const workLogs: WorkLogDTO[] = results.map((row) => ({
    id: row.id,
    repo: row.repo,
    ...(row.issue_ref ? { issueRef: row.issue_ref } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    startMs: row.start_ms,
    endMs: row.end_ms,
  }));

  return c.json<WorkLogsResponse>({ workLogs });
});

// 実績の手動追加 (TimeReportOverlay「実績を手動で追加」フォーム、2026-07-22)。
// POST /api/work-intervals (routes/work-intervals.ts, Bearer 認証, hook 用) とは認証経路が別 —
// こちらはセッション cookie (requireAuth) で、body の形は WorkIntervalRequest と同じ ISO 文字列の
// start/end (web 側が datetime-local → ISO に変換して送る、sync/workLogEntry.ts 参照)。
// owner アカウント解決は行わない — work-intervals.ts と同じ理由 (Google アカウントに紐付かない
// アプリ固有データなので、profileId だけで書ける)。agent 未指定時は resolveManualWorkLogAgent が
// "manual" を補い、これを見て web 側が hook 記録と手動記録を区別する。
workLogsRoutes.post("/api/work-logs", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  let body: WorkLogCreateRequest;
  try {
    body = await c.req.json<WorkLogCreateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    typeof body?.start !== "string" ||
    typeof body?.end !== "string" ||
    typeof body?.repo !== "string"
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  // 任意フィールド (agent/branch/issueRef) は「省略」か「文字列」のみ許す。非文字列を
  // 渡されると下流 (resolveManualWorkLogAgent の .trim() 等) で TypeError → 500 になるため、
  // start/end/repo と同じ流儀でここで 400 に落とす。
  if (
    (body.agent !== undefined && typeof body.agent !== "string") ||
    (body.branch !== undefined && typeof body.branch !== "string") ||
    (body.issueRef !== undefined && typeof body.issueRef !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkLogInput({
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
  });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const row = buildWorkLogRow(
    crypto.randomUUID(),
    profileId,
    {
      startIso: body.start,
      endIso: body.end,
      repo: body.repo,
      branch: body.branch,
      issueRef: body.issueRef,
      agent: resolveManualWorkLogAgent(body.agent),
    },
    Date.now(),
  );
  await insertWorkLog(c.env, row);

  return c.json<WorkLogCreateResponse>({ id: row.id }, 200);
});

// 作業ログの開区間 (実行中) 経路 (docs/mcp.md、0011、2026-07-23)。開始/停止を別々に記録する。
// hook 用の POST /api/work-intervals/start・/stop (routes/work-intervals.ts, Bearer 認証) とは
// 認証経路が別 — こちらは web 用のセッション cookie (requireAuth)。同じ core (startWorkInterval/
// stopWorkInterval) を呼ぶ。型検証は POST /api/work-logs と同じ流儀 (repo は string 必須、任意
// フィールドは省略か string、非文字列は 400 missing_fields)。
workLogsRoutes.post("/api/work-logs/start", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  let body: WorkIntervalStartRequest;
  try {
    body = await c.req.json<WorkIntervalStartRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (typeof body?.repo !== "string") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  if (
    (body.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body.branch !== undefined && typeof body.branch !== "string") ||
    (body.agent !== undefined && typeof body.agent !== "string") ||
    (body.start !== undefined && typeof body.start !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkIntervalStart({ repo: body.repo, startIso: body.start });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const result = await startWorkInterval(c.env, profileId, {
    repo: body.repo,
    issueRef: body.issueRef,
    branch: body.branch,
    agent: body.agent,
    startIso: body.start,
  });
  return c.json<WorkIntervalStartResponse>(result, 200);
});

// 開区間の停止 (cookie 認証)。対応する開始中が無い孤立停止は何も作らず 200 +
// { closed: false, reason: "no_open_interval" } を返す (誤った 0分記録を作らない)。
workLogsRoutes.post("/api/work-logs/stop", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  let body: WorkIntervalStopRequest;
  try {
    body = await c.req.json<WorkIntervalStopRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (typeof body?.repo !== "string") {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  if (
    (body.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body.end !== undefined && typeof body.end !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const validationError = validateWorkIntervalStop({ repo: body.repo, endIso: body.end });
  if (validationError) {
    return c.json<ApiError>({ error: validationError }, 400);
  }

  const result = await stopWorkInterval(c.env, profileId, {
    repo: body.repo,
    issueRef: body.issueRef,
    endIso: body.end,
  });
  return c.json<WorkIntervalStopResponse>(result, 200);
});

// 実行中 (end_ms IS NULL) の開区間一覧 (cookie 認証)。確定済み (GET /api/work-logs → WorkLogDTO)
// とは別 DTO・別経路 — WorkLogDTO.endMs を number のまま保つため、開始中はここだけで返す。
workLogsRoutes.get("/api/work-logs/open", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const open = await listOpenWorkIntervals(c.env, profileId);
  return c.json<OpenWorkIntervalsResponse>({ open });
});

// 実績の手動削除 (手入力の訂正用、2026-07-22)。対象は id が指すプロファイル自身の work_log 行のみ
// — 他プロファイルの id は「無い id」と区別せず 403 にする (block-rules/mcp-tokens と同じ方針)。
// 所有チェック・DELETE 本体は core/work-log.ts の deleteWorkLog に切り出してある。
workLogsRoutes.delete("/api/work-logs/:id", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const id = c.req.param("id");

  const result = await deleteWorkLog(c.env, profileId, id);
  if (result === "not_found") {
    return c.json<ApiError>({ error: "work_log_not_found" }, 403);
  }
  return c.body(null, 204);
});

// 実績の手動編集 (手入力の後追い訂正用、2026-07-23)。全フィールド任意の部分更新 —
// body に含めたキーだけを更新する。認証・所有チェックの方針は DELETE /api/work-logs/:id と同じ
// (セッション cookie / 他プロファイル・存在しない id は区別せず 403 work_log_not_found)。
// 型検証・部分検証は POST /api/work-logs と同じ流儀 (存在するフィールドは各々 string、
// 非文字列は 400 missing_fields)。start/end/repo が来た分だけ validateWorkLogInput 相当で検証する。
//
// start<end の検証方針: start と end の「両方」が同時に来たときだけ行う。片方だけの部分更新では
// 相手側の値が body に無く、更新後の整合を判定するには既存行の start_ms/end_ms を追加で SELECT
// するか、updateWorkLog の戻り値 ("updated"|"not_found") に検証失敗を混ぜる必要があり、DELETE と
// 揃えた薄い所有チェックの流儀に対して複雑さが見合わない。片方更新で区間が反転しても、集計側
// (core/work-log.ts の aggregateWorkLogs) が start_ms >= end_ms の行を除外する防御を既に持つため、
// ここでは「両方来たときだけ」に留める (docs 無し・実装判断)。
//
// 実行中 (end_ms IS NULL) の行に対する PATCH (2026-07-25): 対象が開区間かどうかで経路を分けず、
// 実行中の行も同じ部分更新で編集できる (end を渡せばその場で確定させることもできる)。ただし
// repo/issueRef を変更先のキーで既に別の開区間が走っている状態に変えると、0011 の部分ユニーク
// インデックス idx_work_logs_open に衝突する。以前はこれが未処理例外 → app.onError で 500 に
// なっていたため、updateWorkLog が制約違反を "conflict" として返し、ここで 409 work_log_conflict
// に変換する (400 ではなく 409: 入力自体は正しく、現在の DB 状態と両立しないため)。
workLogsRoutes.patch("/api/work-logs/:id", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const id = c.req.param("id");

  let body: WorkLogUpdateRequest;
  try {
    body = await c.req.json<WorkLogUpdateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  // 全フィールド任意だが、存在するなら string のみ許す (非文字列は下流の Date.parse/D1 bind で
  // 事故になるため、POST と同じく 400 missing_fields に落とす)。
  if (
    (body?.start !== undefined && typeof body.start !== "string") ||
    (body?.end !== undefined && typeof body.end !== "string") ||
    (body?.repo !== undefined && typeof body.repo !== "string") ||
    (body?.issueRef !== undefined && typeof body.issueRef !== "string") ||
    (body?.branch !== undefined && typeof body.branch !== "string") ||
    (body?.agent !== undefined && typeof body.agent !== "string")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  // 与えられた分だけ validateWorkLogInput 相当の検証を行う (部分更新)。
  if (body.repo !== undefined && body.repo.trim().length === 0) {
    return c.json<ApiError>({ error: "missing_repo" }, 400);
  }
  if (body.start !== undefined && Number.isNaN(Date.parse(body.start))) {
    return c.json<ApiError>({ error: "invalid_start" }, 400);
  }
  if (body.end !== undefined && Number.isNaN(Date.parse(body.end))) {
    return c.json<ApiError>({ error: "invalid_end" }, 400);
  }
  // start<end は両方揃ったときだけ (上のコメント参照)。
  if (
    body.start !== undefined &&
    body.end !== undefined &&
    Date.parse(body.start) >= Date.parse(body.end)
  ) {
    return c.json<ApiError>({ error: "start_not_before_end" }, 400);
  }

  const result = await updateWorkLog(c.env, profileId, id, {
    startIso: body.start,
    endIso: body.end,
    repo: body.repo,
    issueRef: body.issueRef,
    branch: body.branch,
    agent: body.agent,
  });
  if (result === "not_found") {
    return c.json<ApiError>({ error: "work_log_not_found" }, 403);
  }
  if (result === "conflict") {
    // 開区間の一意制約 (idx_work_logs_open) と両立しない更新 (上のコメント参照)。
    return c.json<ApiError>({ error: "work_log_conflict" }, 409);
  }
  return c.body(null, 204);
});
