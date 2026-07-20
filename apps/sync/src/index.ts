import { Hono } from "hono";
import type { AppEnv } from "./types";
import { authRoutes } from "./routes/auth";
import { apiRoutes } from "./routes/api";
import { webhookRoutes } from "./routes/webhook";
import { registerWatch, stopWatch, buildWebhookAddress } from "./google/watch";
import {
  buildRenewedWatchRow,
  selectWatchesNeedingRenewal,
  type WatchRow,
} from "./core/watch-service";
import { computeChannelToken } from "./watch-token";

export { UserSyncDO } from "./durable-object/user-sync-do";
export { ProfileHubDO } from "./durable-object/profile-hub-do";

const app = new Hono<AppEnv>();

app.route("/", authRoutes);
app.route("/", apiRoutes);
app.route("/", webhookRoutes);

app.onError((err, c) => {
  console.error("Unhandled error", err);
  return c.json({ error: "internal_error" }, 500);
});

/**
 * 6時間おき (wrangler.jsonc の triggers.crons) に、期限が24時間以内に迫った watch channel を
 * 再登録する。個々の watch の再登録失敗はログして続行する (次の Cron 実行でまた対象になる)。
 */
async function handleScheduled(_event: ScheduledController, env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM watches").all<WatchRow>();
  const needsRenewal = selectWatchesNeedingRenewal(results, Date.now());

  for (const watch of needsRenewal) {
    try {
      await renewWatch(env, watch);
    } catch (err) {
      console.error(
        `cron: failed to renew watch ${watch.channel_id} (account=${watch.account_id}, calendar=${watch.calendar_id})`,
        err,
      );
    }
  }
}

async function renewWatch(env: Env, watch: WatchRow): Promise<void> {
  const stub = env.USER_SYNC.getByName(watch.account_id);
  const tokenResult = await stub.getValidAccessToken(watch.account_id);
  if (!tokenResult.ok) {
    console.warn(
      `cron: could not get access token for account ${watch.account_id}, skipping renewal for now`,
    );
    return;
  }
  const accessToken = tokenResult.data;

  if (watch.resource_id) {
    const stopped = await stopWatch(fetch, accessToken, {
      channelId: watch.channel_id,
      resourceId: watch.resource_id,
    });
    if (!stopped) {
      console.warn(
        `cron: failed to stop old watch channel ${watch.channel_id} (continuing to re-register anyway)`,
      );
    }
  }

  const newChannelId = crypto.randomUUID();
  const channelToken = await computeChannelToken(env.SESSION_SECRET, newChannelId);
  const registered = await registerWatch(fetch, accessToken, {
    calendarId: watch.calendar_id,
    channelId: newChannelId,
    address: buildWebhookAddress(env.WEBHOOK_BASE_URL),
    token: channelToken,
  });

  const newRow = buildRenewedWatchRow(watch, newChannelId, registered, Date.now());

  // 同じ (account_id, calendar_id) の unique index に触れるので、古い行の削除と新しい行の
  // 挿入を1つの batch (D1 のトランザクション) にまとめる。
  await env.DB.batch([
    env.DB.prepare("DELETE FROM watches WHERE channel_id = ?").bind(watch.channel_id),
    env.DB.prepare(
      `INSERT INTO watches (channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newRow.channel_id,
      newRow.resource_id,
      newRow.account_id,
      newRow.calendar_id,
      newRow.profile_id,
      newRow.expiration_ms,
      newRow.created_at,
    ),
  ]);
}

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
