/**
 * kichijitsu MCP サーバー本体 (docs/mcp.md Part B)。
 *
 * 準拠仕様: MCP `2026-07-28` (stateless) + `2025-11-25` 以前 (initialize ベース) の両方。
 * 実装は MCP SDK v2 (`@modelcontextprotocol/server`) の McpServer を
 * Cloudflare Agents SDK の `createMcpHandler` (agents/mcp/server) に載せる。
 * ハンドラが 1 本で両世代を捌く (新世代は `_meta` エンベロープ + `server/discover`、
 * 旧世代は `legacy: "stateless"` レーンが `initialize` を受ける) ため、
 * 設定済みの既存クライアント (Claude 等、`2025-11-25` を話す) はそのまま動く。
 *
 * 2026-07-28 移行前は Agents SDK の `McpAgent` (Durable Object + SDK v1) だったが、
 * `McpAgent` は agents 0.20.0 で deprecated / feature-frozen になり、新仕様
 * (stateless、セッション廃止) を話せないため乗り換えた。DO は状態を持って
 * いなかった (下記 read-through 原則) ので、失われる永続データは無い。
 *
 * read-through 原則: ここで永続化するデータは無い。全ツールは UserSyncDO の既存 RPC を
 * 呼んで Google から取得/書き戻しするだけ (このファイルはその薄いアダプタ)。
 *
 * 認証: routes/mcp.ts が Bearer トークンを検証し、解決済みの `profileId` と `env` を
 * この factory にクロージャで渡す。`getMcpAuthContext()` (AsyncLocalStorage 経由の
 * props) も使えるが、ここでは「呼び出し元が明示的に渡す」方を選んだ — 型が付くし、
 * 未認証で profileId が無い経路が存在し得ないことがシグネチャから読めるため。
 * (未認証リクエストは routes/mcp.ts の時点で 401/403 になりここへ到達しない。)
 *
 * エラー方針: ツール内で RpcResult の ok:false や tenant-isolation 違反 (accountId が
 * このプロファイルに属さない) を検知したら例外を throw する。SDK の registerTool は
 * throw された Error を自動的に `isError: true` の tool result に変換するので、ここで
 * 握り潰したり ok:false 相当の結果を自前で組み立てたりしない。
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GoogleEventDTO } from "@kichijitsu/shared";
import { computeFreeSlots } from "./core/free-slots";
import {
  dedupeEventViews,
  toBusyIntervals,
  toMcpEventView,
  type McpEventView,
} from "./core/mcp-events";
import { defaultSearchWindow, filterEventsByQuery } from "./core/mcp-search";
import type { McpCalendarTarget } from "./core/mcp-targets";
import {
  isMcpAccountOwnedByProfile,
  resolveMcpDefaultWriteAccountId,
  resolveMcpReadTargets,
} from "./mcp-calendars";
import {
  aggregateWorkLogs,
  buildWorkLogRow,
  formatDurationHm,
  insertWorkLog,
  listWorkLogsForProfile,
  startWorkInterval,
  stopWorkInterval,
  validateWorkIntervalStart,
  validateWorkIntervalStop,
  validateWorkLogInput,
} from "./core/work-log";

/**
 * 認証済みプロファイル向けの MCP サーバーインスタンスを 1 つ組み立てる。
 *
 * `createMcpHandler` はリクエストごとにこの factory を呼ぶ (同時実行リクエストが
 * インスタンスを共有しないための SDK v2 の設計)。ここで作るのはツール定義だけで
 * 状態は持たないため、毎回作り直して問題ない。
 */
export function createKichijitsuMcpServer(env: Env, profileId: string): McpServer {
  const server = new McpServer({ name: "kichijitsu", version: "1.0.0" });

  /**
   * 読み取り系ツール共通: 各 target の listEventsInWindow を呼んで集約する。いずれかの
   * target が失敗したら例外を投げる (一部のカレンダーだけ黙って欠落させない — ユーザーは
   * 「そのカレンダーが取得できなかった」ことを知るべきで、静かに不完全な回答を返すよりよい)。
   */
  async function fetchEventsForTargets(
    targets: McpCalendarTarget[],
    timeMin: string,
    timeMax: string,
  ): Promise<{ target: McpCalendarTarget; event: GoogleEventDTO }[]> {
    const collected: { target: McpCalendarTarget; event: GoogleEventDTO }[] = [];
    for (const target of targets) {
      const stub = env.USER_SYNC.getByName(target.accountId);
      const result = await stub.listEventsInWindow(
        target.accountId,
        target.calendarId,
        timeMin,
        timeMax,
      );
      if (!result.ok) {
        throw new Error(
          `mcp: failed to list events for account=${target.accountId} calendar=${target.calendarId}: ${result.error}`,
        );
      }
      for (const event of result.data) {
        collected.push({ target, event });
      }
    }
    return collected;
  }

  async function requireAccountOwnership(accountId: string): Promise<void> {
    const owned = await isMcpAccountOwnedByProfile(env, accountId, profileId);
    if (!owned) {
      throw new Error(`mcp: accountId ${accountId} does not belong to the authenticated profile`);
    }
  }

  /**
   * 書き込み系ツールの accountId 解決: 指定があればプロファイル所有か検証する
   * (tenant-isolation の境界、省略は絶対にしない)。未指定ならデフォルト書き込み先を
   * 解決し、プロファイルにアカウントが1つも無ければ例外を投げる。
   */
  async function resolveWriteAccountId(accountId: string | undefined): Promise<string> {
    if (accountId) {
      await requireAccountOwnership(accountId);
      return accountId;
    }
    const defaultAccountId = await resolveMcpDefaultWriteAccountId(env, profileId);
    if (!defaultAccountId) {
      throw new Error("mcp: profile has no connected Google accounts to write to");
    }
    return defaultAccountId;
  }

  server.registerTool(
    "list_events",
    {
      description:
        "指定した期間の予定一覧を返す (読み取り専用)。繰り返し予定は展開済み。" +
        "timeZone は現状 Google への問い合わせには使われない参考情報。",
      inputSchema: z.object({
        timeMin: z.string(),
        timeMax: z.string(),
        timeZone: z.string().optional(),
      }),
    },
    async ({ timeMin, timeMax }) => {
      const targets = await resolveMcpReadTargets(env, profileId);
      const rawEvents = await fetchEventsForTargets(targets, timeMin, timeMax);
      const events = dedupeEventViews(
        rawEvents.map(({ target, event }) =>
          toMcpEventView(target.accountId, target.calendarId, event),
        ),
      ).sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
      return { content: [{ type: "text", text: JSON.stringify(events) }] };
    },
  );

  server.registerTool(
    "search_events",
    {
      description:
        "キーワードでプロファイルの予定を検索する (読み取り専用)。" +
        "timeMin/timeMax 省略時は今日の30日前〜90日後を検索する。",
      inputSchema: z.object({
        query: z.string(),
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
      }),
    },
    async ({ query, timeMin, timeMax }) => {
      const window = timeMin && timeMax ? { timeMin, timeMax } : defaultSearchWindow(Date.now());
      const targets = await resolveMcpReadTargets(env, profileId);
      const rawEvents = await fetchEventsForTargets(targets, window.timeMin, window.timeMax);

      const matched = filterEventsByQuery(
        rawEvents.map(({ event }) => event),
        query,
      );
      // rawEvents と matched を event.id で突き合わせて accountId/calendarId を復元する
      // (filterEventsByQuery は GoogleEventDTO[] しか見ないため)。
      const matchedIds = new Set(matched.map((event) => event.id));
      const events = dedupeEventViews(
        rawEvents
          .filter(({ event }) => matchedIds.has(event.id))
          .map(({ target, event }) => toMcpEventView(target.accountId, target.calendarId, event)),
      ).sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
      return { content: [{ type: "text", text: JSON.stringify(events) }] };
    },
  );

  server.registerTool(
    "suggest_free_slots",
    {
      description:
        "指定期間・所要時間から空き時間の候補を返す (読み取り専用)。候補は最も早いものから" +
        "時系列順に返る。stepMinutes 省略時は30分刻み、maxCandidates 省略時は全体で最大10件。" +
        "timeZone は現状 UTC 前提の簡易実装。",
      inputSchema: z.object({
        timeMin: z.string(),
        timeMax: z.string(),
        durationMinutes: z.number().int().positive(),
        timeZone: z.string().optional(),
        workingHours: z
          .object({
            startHour: z.number().int().min(0).max(24),
            endHour: z.number().int().min(0).max(24),
          })
          .optional(),
        stepMinutes: z.number().int().positive().optional(),
        maxCandidates: z.number().int().positive().optional(),
      }),
    },
    async ({
      timeMin,
      timeMax,
      durationMinutes,
      timeZone,
      workingHours,
      stepMinutes,
      maxCandidates,
    }) => {
      const targets = await resolveMcpReadTargets(env, profileId);
      const rawEvents = await fetchEventsForTargets(targets, timeMin, timeMax);
      const busy = toBusyIntervals(rawEvents.map(({ event }) => event));

      const slots = computeFreeSlots({
        busy,
        rangeStartMs: Date.parse(timeMin),
        rangeEndMs: Date.parse(timeMax),
        durationMs: durationMinutes * 60_000,
        workingHours,
        timeZone,
        stepMinutes,
        maxCandidates,
      }).map((slot) => ({
        startMs: new Date(slot.startMs).toISOString(),
        endMs: new Date(slot.endMs).toISOString(),
      }));
      return { content: [{ type: "text", text: JSON.stringify(slots) }] };
    },
  );

  server.registerTool(
    "create_event",
    {
      description:
        "実行するとユーザーの Google カレンダーに新しい予定が作成される。実行前にユーザーに確認すること。",
      inputSchema: z.object({
        title: z.string(),
        start: z.string(),
        end: z.string(),
        timeZone: z.string(),
        accountId: z.string().optional(),
        calendarId: z.string().optional(),
      }),
    },
    async ({ title, start, end, timeZone, accountId, calendarId }) => {
      const resolvedAccountId = await resolveWriteAccountId(accountId);
      const resolvedCalendarId = calendarId ?? "primary";
      const startMs = parseRequiredDate(start, "start");
      const endMs = parseRequiredDate(end, "end");

      const stub = env.USER_SYNC.getByName(resolvedAccountId);
      const result = await stub.createEvent(
        resolvedAccountId,
        resolvedCalendarId,
        title,
        startMs,
        endMs,
        timeZone,
      );
      if (!result.ok) {
        throw new Error(`create_event failed: ${result.error} (status ${result.status})`);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              eventId: result.data,
              accountId: resolvedAccountId,
              calendarId: resolvedCalendarId,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "update_event",
    {
      description:
        "実行するとユーザーの Google カレンダーの既存の予定が変更される。実行前にユーザーに確認すること。" +
        "start/end/timeZone は必須。summary/location/description は省略可能で、指定した" +
        "フィールドのみが更新され、省略したフィールドは元の値のまま保持される " +
        "(Google の events.patch のマージ更新の挙動)。空文字を指定するとそのフィールドを" +
        'クリアできる (例: location: "" で場所を削除)。RSVP (自分の参加ステータス変更) は' +
        "このツールでは行えない。終日予定への変更もこのツールでは行えない (時刻予定のみ)。",
      inputSchema: z.object({
        accountId: z.string(),
        calendarId: z.string(),
        eventId: z.string(),
        start: z.string(),
        end: z.string(),
        timeZone: z.string(),
        summary: z.string().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
      }),
    },
    async ({
      accountId,
      calendarId,
      eventId,
      start,
      end,
      timeZone,
      summary,
      location,
      description,
    }) => {
      await requireAccountOwnership(accountId);
      const startMs = parseRequiredDate(start, "start");
      const endMs = parseRequiredDate(end, "end");

      const stub = env.USER_SYNC.getByName(accountId);
      const result = await stub.patchEvent(
        accountId,
        calendarId,
        eventId,
        startMs,
        endMs,
        timeZone,
        { summary, location, description },
      );
      if (!result.ok) {
        throw new Error(`update_event failed: ${result.error} (status ${result.status})`);
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "delete_event",
    {
      description:
        "実行するとユーザーの Google カレンダーから予定が削除される。実行前にユーザーに確認すること。この操作は取り消せない。",
      inputSchema: z.object({
        accountId: z.string(),
        calendarId: z.string(),
        eventId: z.string(),
      }),
    },
    async ({ accountId, calendarId, eventId }) => {
      await requireAccountOwnership(accountId);

      const stub = env.USER_SYNC.getByName(accountId);
      const result = await stub.deleteEvent(accountId, calendarId, eventId);
      if (!result.ok) {
        throw new Error(`delete_event failed: ${result.error} (status ${result.status})`);
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "log_work_interval",
    {
      description:
        "作業実績を記録する (kichijitsu の work_logs テーブルに保存、Google カレンダーには書き込まない)。" +
        "Claude Code 等の hook から呼ぶことを想定 (docs/mcp.md)。",
      inputSchema: z.object({
        start: z.string(),
        end: z.string(),
        repo: z.string(),
        branch: z.string().optional(),
        issueRef: z.string().optional(),
        agent: z.string().optional(),
        timeZone: z.string().optional(),
      }),
    },
    // timeZone は D1 保存では不要 (Date.parse が offset 込みの ISO を直接 epoch ms へ変換する)
    // だが、既存 hook との後方互換のため入力スキーマとしては受け付けたまま無視する。
    async ({ start, end, repo, branch, issueRef, agent }) => {
      const input = { startIso: start, endIso: end, repo, branch, issueRef, agent };
      const validationError = validateWorkLogInput(input);
      if (validationError) {
        throw new Error(`log_work_interval: invalid input (${validationError})`);
      }

      const row = buildWorkLogRow(crypto.randomUUID(), profileId, input, Date.now());
      await insertWorkLog(env, row);
      return { content: [{ type: "text", text: JSON.stringify({ id: row.id }) }] };
    },
  );

  server.registerTool(
    "start_work_interval",
    {
      description:
        "作業の開始を記録する (開区間を1本立てる、docs/mcp.md)。停止は stop_work_interval で行う。" +
        "同一 (repo, issueRef) の開始中が既にあれば新規作成せず既存を返す (二重開始の防御)。" +
        "start (ISO) 省略時はサーバーの現在時刻。",
      inputSchema: z.object({
        repo: z.string(),
        issueRef: z.string().optional(),
        branch: z.string().optional(),
        agent: z.string().optional(),
        start: z.string().optional(),
        timeZone: z.string().optional(),
      }),
    },
    // timeZone は D1 保存では不要 (Date.parse が offset 込みの ISO を直接 epoch ms へ変換する) だが、
    // 他の work-log ツールと揃えて後方互換のため受け付けたまま無視する。
    async ({ repo, issueRef, branch, agent, start }) => {
      const validationError = validateWorkIntervalStart({ repo, startIso: start });
      if (validationError) {
        throw new Error(`start_work_interval: invalid input (${validationError})`);
      }
      const result = await startWorkInterval(env, profileId, {
        repo,
        issueRef,
        branch,
        agent,
        startIso: start,
      });
      const text = result.alreadyOpen
        ? `既に開始中の作業があります (再開始せず既存を返しました)。id=${result.id}`
        : `作業を開始しました。id=${result.id}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "stop_work_interval",
    {
      description:
        "作業の停止を記録する (対応する開区間に end を書き込んで確定、docs/mcp.md)。" +
        "対応する開始中が無い場合は何も記録しない (孤立停止を無視)。" +
        "end (ISO) 省略時はサーバーの現在時刻。",
      inputSchema: z.object({
        repo: z.string(),
        issueRef: z.string().optional(),
        end: z.string().optional(),
        timeZone: z.string().optional(),
      }),
    },
    async ({ repo, issueRef, end }) => {
      const validationError = validateWorkIntervalStop({ repo, endIso: end });
      if (validationError) {
        throw new Error(`stop_work_interval: invalid input (${validationError})`);
      }
      const result = await stopWorkInterval(env, profileId, { repo, issueRef, endIso: end });
      const text = result.closed
        ? `作業を停止しました。id=${result.id}`
        : `対応する開始中の作業が見つかりませんでした (何も記録していません、reason=${result.reason})。`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "work_summary",
    {
      description:
        "hook (log_work_interval) で記録した作業実績を repo/issue 単位で集計して返す " +
        "(読み取り専用)。予定のタイムブロックや手動タイマーはクライアント側のみのデータであり、" +
        "ここには含まれない — サーバーが持つのは hook 実績 (work_logs) のみ。" +
        "since/until (ISO、任意) を指定すると work_logs の start/end で絞り込む。",
      inputSchema: z.object({
        since: z.string().optional(),
        until: z.string().optional(),
      }),
    },
    async ({ since, until }) => {
      const sinceMs = since !== undefined ? parseRequiredDate(since, "since") : undefined;
      const untilMs = until !== undefined ? parseRequiredDate(until, "until") : undefined;

      const rows = await listWorkLogsForProfile(env, profileId, sinceMs, untilMs);
      const items = aggregateWorkLogs(rows).map((item) => ({
        ...item,
        totalHm: formatDurationHm(item.totalMs),
      }));
      return { content: [{ type: "text", text: JSON.stringify(items) }] };
    },
  );

  return server;
}

function eventSortKey(event: McpEventView): string {
  return event.start?.dateTime ?? event.start?.date ?? "";
}

function parseRequiredDate(value: string, label: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`mcp: invalid ${label} date: ${value}`);
  }
  return ms;
}
