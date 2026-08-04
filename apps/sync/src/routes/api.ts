/**
 * `/api/*` の入口。以前はこのファイル1つに35ルート全てが書かれていたが、ドメイン別に
 * サブルーターへ分割し、ここは populateProfileId の適用とマウントだけを行う束ね役にした
 * (2026-07-25)。挙動 (パス・ミドルウェア適用順・レスポンス) は分割前と変えていない。
 *
 * 各ドメインのルートは以下のファイルにある:
 * - github.ts: GET/DELETE /api/github* (withGitHubToken ヘルパーも同居)
 * - work-logs.ts: /api/work-logs*
 * - events.ts: /api/sync, /api/event/*, /api/events (SSE)
 * - calendars-tasks.ts: /api/calendars, /api/tasklists, /api/tasks/sync, /api/task/patch
 * - settings.ts: /api/me, /api/visible-calendars, /api/block-rules*, /api/mcp-tokens*,
 *   /api/watch, /api/account
 * - block-mirrors.ts: /api/block-mirrors/orphans, /api/block-mirrors/cleanup
 *   (孤児ミラー掃除、docs/blocking.md「将来やるならこれ」、2026-08-04)
 * - respond.ts: respondFromRpcResult (github.ts 以外の複数ルーターで共有)
 * - ../watch-registration.ts: enableWatch/disableWatch/repairWatchIfNeeded
 *   (settings.ts の POST /api/watch と events.ts の自己修復の両方が使うため routes/ の外)
 */
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { populateProfileId } from "../middleware";
import { githubRoutes } from "./github";
import { workLogsRoutes } from "./work-logs";
import { eventRoutes } from "./events";
import { calendarsTasksRoutes } from "./calendars-tasks";
import { settingsRoutes } from "./settings";
import { blockMirrorsRoutes } from "./block-mirrors";

export const apiRoutes = new Hono<AppEnv>();

// populateProfileId はここで1回だけ適用する。各サブルーターで use("*") すると
// マウント後に1リクエストあたり何度も cookie 検証が走ってしまうため。
apiRoutes.use("*", populateProfileId);

apiRoutes.route("/", githubRoutes);
apiRoutes.route("/", workLogsRoutes);
apiRoutes.route("/", eventRoutes);
apiRoutes.route("/", calendarsTasksRoutes);
apiRoutes.route("/", settingsRoutes);
apiRoutes.route("/", blockMirrorsRoutes);
