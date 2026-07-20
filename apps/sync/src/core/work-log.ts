import { insertEventWithRetry, type InsertEventCoreDeps } from "./insert-event";
import { findCalendarBySummary, createCalendar } from "../google/calendars";

/**
 * 作業実績記録機能 (docs/mcp.md「エージェントの作業時間記録」)。Claude Code 等の hook から
 * MCP ツール `log_work_interval` / REST `POST /api/work-intervals` の両方が呼ぶ共通コア。
 * サーバーは予定を保存しない原則を維持するため、記録先は D1 ではなくユーザーの Google
 * カレンダー自身 (専用の「kichijitsu 実績」カレンダー、無ければ自動作成) — カレンダーブロック
 * 機能の mirror 作成と同じ insertEventWithRetry (401 リトライ込み) を汎用化して流用する。
 */

export const WORK_LOG_CALENDAR_SUMMARY = "kichijitsu 実績";

export interface WorkLogInput {
  startIso: string;
  endIso: string;
  repo: string;
  branch?: string;
  issueRef?: string;
  agent?: string;
  timeZone?: string;
}

/** Google events.insert に渡す実績イベント本体。MirrorEventBody と違い内容 (summary/description) を持つ。 */
export interface WorkLogEventBody {
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  description: string;
  transparency: "transparent";
  visibility: "private";
  extendedProperties: { private: Record<string, string> };
  /**
   * 実績イベントは常に busy 相当で OOO フォールバックの対象外だが、insertEventWithRetry の
   * `TBody extends { eventType?: "outOfOffice" }` 制約 (TypeScript の weak type detection —
   * プロパティを1つも共有しない型は弾かれる) を満たすためだけに宣言してある。実際に
   * "outOfOffice" を設定することはない。
   */
  eventType?: undefined;
}

export type WorkLogValidationError =
  | "missing_repo"
  | "invalid_start"
  | "invalid_end"
  | "start_not_before_end";

/**
 * 純関数。start<end・ISO パース可・repo 必須を検証する。routes/work-intervals.ts (400への
 * マッピング) と logWorkInterval (呼び出し元の防御、MCP ツール経路はここでしか検証されない
 * ため) の両方から呼ぶ。
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
 * 純関数。実績イベントの Google events.insert 用 body を組み立てる。
 * summary: issueRef があれば `${repo}#${issueRef}`、無く branch があれば `${repo} (${branch})`、
 * どちらも無ければ repo のみ。
 * transparency: 'transparent' (予定の空き判定を妨げない、ブロックカレンダーの mirror とは
 * 逆の性質 — 実績は「その時間何をしていたか」の記録であり、他の予定調整を邪魔すべきではない)。
 * visibility: 'private'。
 * extendedProperties.private.kichijitsuWorkLog='1' で後から機械的に識別できるようにする
 * (予定 vs 実績の issueRef 突き合わせは次増分、docs/mcp.md「エージェントの作業時間記録」)。
 */
export function buildWorkLogEvent(input: WorkLogInput): WorkLogEventBody {
  const timeZone = input.timeZone ?? "UTC";
  const summary = input.issueRef
    ? `${input.repo}#${input.issueRef}`
    : input.branch
      ? `${input.repo} (${input.branch})`
      : input.repo;

  const descriptionLines: string[] = [];
  if (input.agent) descriptionLines.push(`agent: ${input.agent}`);
  if (input.branch) descriptionLines.push(`branch: ${input.branch}`);
  if (input.issueRef) descriptionLines.push(`issue: #${input.issueRef}`);

  const extendedPrivate: Record<string, string> = {
    kichijitsuWorkLog: "1",
    repo: input.repo,
  };
  if (input.issueRef) extendedPrivate.issueRef = input.issueRef;
  if (input.branch) extendedPrivate.branch = input.branch;
  if (input.agent) extendedPrivate.agent = input.agent;

  return {
    summary,
    start: { dateTime: input.startIso, timeZone },
    end: { dateTime: input.endIso, timeZone },
    description: descriptionLines.join("\n"),
    transparency: "transparent",
    visibility: "private",
    extendedProperties: { private: extendedPrivate },
  };
}

/**
 * 「kichijitsu 実績」カレンダーを探し、無ければ作成する。作成は最大1回だけ行われる
 * (見つかればそれを使う、find-or-create)。calendarList の検索は毎回行う (キャッシュしない
 * — 作成頻度はごく低く、hook 呼び出し1回ごとの calendarList 1往復のコストは許容範囲)。
 */
export async function findOrCreateWorkLogCalendar(deps: InsertEventCoreDeps): Promise<string> {
  const accessToken = await deps.getAccessToken();
  const existingId = await findCalendarBySummary(
    deps.fetch,
    accessToken,
    WORK_LOG_CALENDAR_SUMMARY,
  );
  if (existingId) return existingId;
  return createCalendar(deps.fetch, accessToken, WORK_LOG_CALENDAR_SUMMARY);
}

/**
 * 作業実績の記録本体。find-or-create → buildWorkLogEvent → insertEventWithRetry (既存の
 * mirror event 作成経路を汎用化して流用、401 リトライも効く) の順で実行する。deps は
 * UserSyncDO.buildEventWriteDeps と同じ形 (InsertEventCoreDeps) を渡す想定 — 呼び出し元の
 * accountId は常にプロファイルの owner アカウント (mcp-calendars.ts の
 * resolveMcpOwnerAccountId で解決済みのものを渡す、docs/mcp.md「対象アカウント」)。
 */
export async function logWorkInterval(
  deps: InsertEventCoreDeps,
  input: WorkLogInput,
): Promise<{ calendarId: string; eventId: string }> {
  const validationError = validateWorkLogInput(input);
  if (validationError) {
    throw new Error(`work-log: invalid input (${validationError})`);
  }
  const calendarId = await findOrCreateWorkLogCalendar(deps);
  const body = buildWorkLogEvent(input);
  const { id } = await insertEventWithRetry(deps, calendarId, body);
  return { calendarId, eventId: id };
}
