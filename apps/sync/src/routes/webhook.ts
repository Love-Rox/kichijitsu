import { Hono } from "hono";
import type { AppEnv } from "../types";
import { decideWebhookAction, type WatchRow } from "../core/webhook";
import { computeChannelToken } from "../watch-token";

export const webhookRoutes = new Hono<AppEnv>();

// Google からの push 通知。セッション不要 (populateProfileId は他ルートと共通のグローバル
// ミドルウェアではなく apiRoutes だけに掛かっているので、ここでは何もしなくてよい)。
// sync ペイロード (request body) は一切読まない — 通知はトリガーに過ぎず、差分は
// クライアントが /api/sync で取りに行く設計のため。
webhookRoutes.post("/api/webhook/google", async (c) => {
  const channelId = c.req.header("X-Goog-Channel-Id") ?? null;
  const channelToken = c.req.header("X-Goog-Channel-Token") ?? null;
  const resourceState = c.req.header("X-Goog-Resource-State") ?? null;

  const watch = channelId
    ? await c.env.DB.prepare(
        "SELECT channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at FROM watches WHERE channel_id = ?",
      )
        .bind(channelId)
        .first<WatchRow>()
    : null;

  const decision = await decideWebhookAction(
    (id) => computeChannelToken(c.env.SESSION_SECRET, id),
    watch,
    channelId,
    channelToken,
    resourceState,
  );

  if (decision.action === "reject") {
    // channel 不明とトークン不一致を区別しない (存在有無を漏らさないため)。
    return c.body(null, 404);
  }
  if (decision.action === "ignore_sync") {
    // 登録直後の初回通知 (X-Goog-Resource-State: sync)。無視して 200 を返すだけでよい。
    return c.body(null, 200);
  }

  const stub = c.env.PROFILE_HUB.getByName(decision.profileId);
  await stub.notifyChanged(decision.accountId, decision.calendarId);
  return c.body(null, 200);
});
