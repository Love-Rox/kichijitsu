/**
 * kichijitsu MCP サーバー本体 (docs/mcp.md Part B)。Cloudflare Agents SDK の McpAgent
 * (Durable Object ベース、Streamable HTTP) として実装する。
 *
 * read-through 原則: ここで永続化するデータは無い。全ツールは UserSyncDO の既存 RPC を
 * 呼んで Google から取得/書き戻しするだけ (このファイルはその薄いアダプタ)。
 *
 * 認証: routes/mcp.ts が Bearer トークンを検証して `ExecutionContext.props` に
 * `{ profileId }` (McpProps) をセットしてから McpAgent.serve(...).fetch(...) に委譲する
 * (@cloudflare/workers-oauth-provider が使うのと同じ仕組み、agents 自身の
 * getAgentByName(..., { props: ctx.props }) 経由でこの DO の `this.props` に届く)。
 * ここでは `this.props.profileId` を信頼できる呼び出し元の身元として扱うだけで、
 * 認証そのものはしない (未認証で ctx.props が無いリクエストは routes/mcp.ts の時点で
 * 401 になり、この DO には到達しない)。
 *
 * エラー方針: ツール内で RpcResult の ok:false や tenant-isolation 違反 (accountId が
 * このプロファイルに属さない) を検知したら例外を throw する。MCP SDK の registerTool は
 * throw された Error を自動的に `isError: true` の tool result に変換するので、ここで
 * 握り潰したり ok:false 相当の結果を自前で組み立てたりしない。
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GoogleEventDTO } from "@kichijitsu/shared";
import { computeFreeSlots } from "../core/free-slots";
import {
  dedupeEventViews,
  toBusyIntervals,
  toMcpEventView,
  type McpEventView,
} from "../core/mcp-events";
import { defaultSearchWindow, filterEventsByQuery } from "../core/mcp-search";
import type { McpCalendarTarget } from "../core/mcp-targets";
import {
  isMcpAccountOwnedByProfile,
  resolveMcpDefaultWriteAccountId,
  resolveMcpOwnerAccountId,
  resolveMcpReadTargets,
} from "../mcp-calendars";

export interface McpProps extends Record<string, unknown> {
  profileId: string;
}

export class KichijitsuMcpAgent extends McpAgent<Env, unknown, McpProps> {
  server = new McpServer({ name: "kichijitsu", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "list_events",
      {
        description:
          "指定した期間の予定一覧を返す (読み取り専用)。繰り返し予定は展開済み。" +
          "timeZone は現状 Google への問い合わせには使われない参考情報。",
        inputSchema: {
          timeMin: z.string(),
          timeMax: z.string(),
          timeZone: z.string().optional(),
        },
      },
      async ({ timeMin, timeMax }) => {
        const profileId = this.requireProfileId();
        const targets = await resolveMcpReadTargets(this.env, profileId);
        const rawEvents = await this.fetchEventsForTargets(targets, timeMin, timeMax);
        const events = dedupeEventViews(
          rawEvents.map(({ target, event }) =>
            toMcpEventView(target.accountId, target.calendarId, event),
          ),
        ).sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
        return { content: [{ type: "text", text: JSON.stringify(events) }] };
      },
    );

    this.server.registerTool(
      "search_events",
      {
        description:
          "キーワードでプロファイルの予定を検索する (読み取り専用)。" +
          "timeMin/timeMax 省略時は今日の30日前〜90日後を検索する。",
        inputSchema: {
          query: z.string(),
          timeMin: z.string().optional(),
          timeMax: z.string().optional(),
        },
      },
      async ({ query, timeMin, timeMax }) => {
        const profileId = this.requireProfileId();
        const window = timeMin && timeMax ? { timeMin, timeMax } : defaultSearchWindow(Date.now());
        const targets = await resolveMcpReadTargets(this.env, profileId);
        const rawEvents = await this.fetchEventsForTargets(targets, window.timeMin, window.timeMax);

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

    this.server.registerTool(
      "suggest_free_slots",
      {
        description:
          "指定期間・所要時間から空き時間の候補を返す (読み取り専用)。候補は最も早いものから" +
          "時系列順に返る。stepMinutes 省略時は30分刻み、maxCandidates 省略時は全体で最大10件。" +
          "timeZone は現状 UTC 前提の簡易実装。",
        inputSchema: {
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
        },
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
        const profileId = this.requireProfileId();
        const targets = await resolveMcpReadTargets(this.env, profileId);
        const rawEvents = await this.fetchEventsForTargets(targets, timeMin, timeMax);
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

    this.server.registerTool(
      "create_event",
      {
        description:
          "実行するとユーザーの Google カレンダーに新しい予定が作成される。実行前にユーザーに確認すること。",
        inputSchema: {
          title: z.string(),
          start: z.string(),
          end: z.string(),
          timeZone: z.string(),
          accountId: z.string().optional(),
          calendarId: z.string().optional(),
        },
      },
      async ({ title, start, end, timeZone, accountId, calendarId }) => {
        const profileId = this.requireProfileId();
        const resolvedAccountId = await this.resolveWriteAccountId(profileId, accountId);
        const resolvedCalendarId = calendarId ?? "primary";
        const startMs = parseRequiredDate(start, "start");
        const endMs = parseRequiredDate(end, "end");

        const stub = this.env.USER_SYNC.getByName(resolvedAccountId);
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

    this.server.registerTool(
      "update_event",
      {
        description:
          "実行するとユーザーの Google カレンダーの既存の予定の日時が変更される。実行前にユーザーに確認すること。" +
          "タイトルなど時刻以外のフィールドは変更できない（既存 RPC の制約）。",
        inputSchema: {
          accountId: z.string(),
          calendarId: z.string(),
          eventId: z.string(),
          start: z.string(),
          end: z.string(),
          timeZone: z.string(),
        },
      },
      async ({ accountId, calendarId, eventId, start, end, timeZone }) => {
        const profileId = this.requireProfileId();
        await this.requireAccountOwnership(profileId, accountId);
        const startMs = parseRequiredDate(start, "start");
        const endMs = parseRequiredDate(end, "end");

        const stub = this.env.USER_SYNC.getByName(accountId);
        const result = await stub.patchEvent(
          accountId,
          calendarId,
          eventId,
          startMs,
          endMs,
          timeZone,
        );
        if (!result.ok) {
          throw new Error(`update_event failed: ${result.error} (status ${result.status})`);
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    this.server.registerTool(
      "delete_event",
      {
        description:
          "実行するとユーザーの Google カレンダーから予定が削除される。実行前にユーザーに確認すること。この操作は取り消せない。",
        inputSchema: {
          accountId: z.string(),
          calendarId: z.string(),
          eventId: z.string(),
        },
      },
      async ({ accountId, calendarId, eventId }) => {
        const profileId = this.requireProfileId();
        await this.requireAccountOwnership(profileId, accountId);

        const stub = this.env.USER_SYNC.getByName(accountId);
        const result = await stub.deleteEvent(accountId, calendarId, eventId);
        if (!result.ok) {
          throw new Error(`delete_event failed: ${result.error} (status ${result.status})`);
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    this.server.registerTool(
      "log_work_interval",
      {
        description:
          "作業実績を Google カレンダーの「kichijitsu 実績」に記録する（カレンダーに書き込む）。" +
          "無ければカレンダーを自動作成する。Claude Code 等の hook から呼ぶことを想定 (docs/mcp.md)。",
        inputSchema: {
          start: z.string(),
          end: z.string(),
          repo: z.string(),
          branch: z.string().optional(),
          issueRef: z.string().optional(),
          agent: z.string().optional(),
          timeZone: z.string().optional(),
        },
      },
      async ({ start, end, repo, branch, issueRef, agent, timeZone }) => {
        const profileId = this.requireProfileId();
        const accountId = await resolveMcpOwnerAccountId(this.env, profileId);
        if (!accountId) {
          throw new Error("mcp: profile has no owner account to log work intervals against");
        }

        const stub = this.env.USER_SYNC.getByName(accountId);
        const result = await stub.logWorkInterval(accountId, {
          startIso: start,
          endIso: end,
          repo,
          branch,
          issueRef,
          agent,
          timeZone,
        });
        if (!result.ok) {
          throw new Error(`log_work_interval failed: ${result.error} (status ${result.status})`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result.data) }] };
      },
    );
  }

  private requireProfileId(): string {
    const profileId = this.props?.profileId;
    if (!profileId) throw new Error("mcp: missing profileId (unauthenticated)");
    return profileId;
  }

  /**
   * 書き込み系ツールの accountId 解決: 指定があればプロファイル所有か検証する
   * (tenant-isolation の境界、省略は絶対にしない)。未指定ならデフォルト書き込み先を
   * 解決し、プロファイルにアカウントが1つも無ければ例外を投げる。
   */
  private async resolveWriteAccountId(
    profileId: string,
    accountId: string | undefined,
  ): Promise<string> {
    if (accountId) {
      await this.requireAccountOwnership(profileId, accountId);
      return accountId;
    }
    const defaultAccountId = await resolveMcpDefaultWriteAccountId(this.env, profileId);
    if (!defaultAccountId) {
      throw new Error("mcp: profile has no connected Google accounts to write to");
    }
    return defaultAccountId;
  }

  private async requireAccountOwnership(profileId: string, accountId: string): Promise<void> {
    const owned = await isMcpAccountOwnedByProfile(this.env, accountId, profileId);
    if (!owned) {
      throw new Error(`mcp: accountId ${accountId} does not belong to the authenticated profile`);
    }
  }

  /**
   * 読み取り系ツール共通: 各 target の listEventsInWindow を呼んで集約する。いずれかの
   * target が失敗したら例外を投げる (一部のカレンダーだけ黙って欠落させない — ユーザーは
   * 「そのカレンダーが取得できなかった」ことを知るべきで、静かに不完全な回答を返すよりよい)。
   */
  private async fetchEventsForTargets(
    targets: McpCalendarTarget[],
    timeMin: string,
    timeMax: string,
  ): Promise<{ target: McpCalendarTarget; event: GoogleEventDTO }[]> {
    const collected: { target: McpCalendarTarget; event: GoogleEventDTO }[] = [];
    for (const target of targets) {
      const stub = this.env.USER_SYNC.getByName(target.accountId);
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
