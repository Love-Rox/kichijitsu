import { timingSafeEqual } from "../watch-token";

/** watches テーブルの1行 (D1 のスキーマそのまま)。 */
export interface WatchRow {
  channel_id: string;
  resource_id: string | null;
  account_id: string;
  calendar_id: string;
  profile_id: string;
  expiration_ms: number | null;
  created_at: number;
}

export type WebhookDecision =
  | { action: "reject" }
  /** X-Goog-Resource-State: sync (登録直後の初回通知)。何もせず 200 を返すだけでよい。 */
  | { action: "ignore_sync" }
  | { action: "notify"; accountId: string; calendarId: string; profileId: string };

/**
 * POST /api/webhook/google の中身。ペイロード (request body) は一切読まない
 * (Google からの通知は「何かが変わった」というトリガーに過ぎず、内容を信用しない設計)。
 * X-Goog-Channel-Id で watches を引き、X-Goog-Channel-Token を HMAC 再計算で検証する。
 * 未知の channel_id・トークン不一致はどちらも 'reject' (呼び出し側は 404 を返す) にし、
 * 「channel が存在しない」と「トークンが違う」を区別しない (存在有無を漏らさないため)。
 */
export async function decideWebhookAction(
  computeExpectedToken: (channelId: string) => Promise<string>,
  watch: WatchRow | null,
  channelId: string | null,
  channelToken: string | null,
  resourceState: string | null,
): Promise<WebhookDecision> {
  if (!channelId || !channelToken || !watch) {
    return { action: "reject" };
  }

  const expected = await computeExpectedToken(channelId);
  if (!timingSafeEqual(expected, channelToken)) {
    return { action: "reject" };
  }

  if (resourceState === "sync") {
    return { action: "ignore_sync" };
  }

  return {
    action: "notify",
    accountId: watch.account_id,
    calendarId: watch.calendar_id,
    profileId: watch.profile_id,
  };
}
