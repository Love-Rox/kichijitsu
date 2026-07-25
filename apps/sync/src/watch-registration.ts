/**
 * watch (Google カレンダーの push 通知チャンネル) の登録/解除/自己修復。
 *
 * POST /api/watch (routes/settings.ts) と、POST /api/sync 成功後の自己修復
 * (routes/events.ts) の両方から使われるため、どちらのルートファイルにも属さずここに置く。
 * D1/Google に触れる非純粋なヘルパーなので core/ ではなく src/ 直下 (mcp-auth.ts /
 * mcp-calendars.ts と同じ位置づけ)。
 */

import { registerWatch, stopWatch, buildWebhookAddress } from "./google/watch";
import { buildWatchRow, shouldAttemptWatchRepair, shouldEnsureWatch } from "./core/watch-service";
import { computeChannelToken } from "./watch-token";

/**
 * watch 登録の本体。既存行が現プロファイルに紐づき、かつ未失効ならその行を信頼して Google を
 * 呼ばずに何もしない (true を返す)。既存行が古いプロファイルに紐づく、または失効している場合は
 * Cron の再登録 (renewWatch, ../index.ts) と同じ順序 — 古い channel を stop → 新しい channel を
 * 登録 → (account_id, calendar_id) の unique index に触れるため削除+挿入を1つの batch に
 * まとめる — で張り替える (POST /api/sync 成功後の自己修復 (下記 repairWatchIfNeeded) は
 * この張り替えに乗っかる)。
 * それ以外の失敗 (アクセストークン取得不可・Google API エラー・localhost 拒否など) は
 * すべて best-effort として飲み込み false を返す — 呼び出し元はこれを 200 として返す
 * (POST /api/watch) か、ログするだけ (repairWatchIfNeeded) にする。
 */
export async function enableWatch(
  env: Env,
  accountId: string,
  calendarId: string,
  profileId: string,
): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT channel_id, resource_id, profile_id, expiration_ms FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{
      channel_id: string;
      resource_id: string | null;
      profile_id: string;
      expiration_ms: number | null;
    }>();

  const now = Date.now();
  // expiration_ms が null (Google が expiration を返さなかった watch) は「いつ切れるか
  // 分からない」行なので、既に切れている (0 < now) 扱いにして張り替え側に倒す — Cron の
  // selectWatchesNeedingRenewal とは逆の安全側 (張り替えは stop→re-register の二重登録耐性が
  // あるだけの best-effort 操作であり、Cron の「触らず待つ」判断とは前提が違う)。
  if (
    existing &&
    !shouldEnsureWatch(
      { profile_id: existing.profile_id, expiration_ms: existing.expiration_ms ?? 0 },
      profileId,
      now,
    )
  ) {
    return true;
  }

  try {
    const stub = env.USER_SYNC.getByName(accountId);
    const tokenResult = await stub.getValidAccessToken(accountId);
    if (!tokenResult.ok) {
      console.warn(
        `watch registration: could not get access token for account ${accountId}: ${tokenResult.error}`,
      );
      return false;
    }

    if (existing?.resource_id) {
      const stopped = await stopWatch(fetch, tokenResult.data, {
        channelId: existing.channel_id,
        resourceId: existing.resource_id,
      });
      if (!stopped) {
        console.warn(
          `watch registration: failed to stop stale channel ${existing.channel_id} for account=${accountId} calendar=${calendarId} (continuing to re-register anyway)`,
        );
      }
    }

    const channelId = crypto.randomUUID();
    const channelToken = await computeChannelToken(env.SESSION_SECRET, channelId);
    const registered = await registerWatch(fetch, tokenResult.data, {
      calendarId,
      channelId,
      address: buildWebhookAddress(env.WEBHOOK_BASE_URL),
      token: channelToken,
    });

    const row = buildWatchRow({ accountId, calendarId }, profileId, channelId, registered, now);
    const insert = env.DB.prepare(
      `INSERT INTO watches (channel_id, resource_id, account_id, calendar_id, profile_id, expiration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.channel_id,
      row.resource_id,
      row.account_id,
      row.calendar_id,
      row.profile_id,
      row.expiration_ms,
      row.created_at,
    );

    if (existing) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM watches WHERE account_id = ? AND calendar_id = ?").bind(
          accountId,
          calendarId,
        ),
        insert,
      ]);
    } else {
      await insert.run();
    }

    return true;
  } catch (err) {
    console.warn(
      `watch registration failed (best-effort) for account=${accountId} calendar=${calendarId}`,
      err,
    );
    return false;
  }
}

/** キー = `${accountId}:${calendarId}`、値 = 最終「登録試行」時刻 (ms)。isolate 単位で揮発する
 * best-effort のスロットルであり、D1 に永続化するほどの重要性は無い (押しても実害は
 * 「次の isolate でもう1回試す」程度)。 */
const lastWatchRepairAttempt = new Map<string, number>();

/**
 * POST /api/sync 成功後の watch 自己修復 (best-effort)。
 *
 * watch 登録の正経路はクライアントがカレンダー選択をトグルした時の POST /api/watch
 * (enabled:true) であり、これはそれを補うだけの自己修復 — プロファイル作り直し事故などで
 * watches 行が失われた/古いプロファイルに紐づいたまま残ったケースを、次の同期成功時に検知
 * して直す。呼び出し元 (POST /api/sync) は waitUntil に渡すので、レスポンスはブロックしない。
 */
export async function repairWatchIfNeeded(
  env: Env,
  accountId: string,
  calendarId: string,
  profileId: string,
  now: number,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT profile_id, expiration_ms FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{ profile_id: string; expiration_ms: number | null }>();

  const row = existing
    ? { profile_id: existing.profile_id, expiration_ms: existing.expiration_ms ?? 0 }
    : null;
  if (!shouldEnsureWatch(row, profileId, now)) {
    return;
  }

  // push 非対応カレンダー (祝日カレンダーなど) は登録の度に失敗するので、同期の度に Google を
  // 叩き続けないようスロットルする。
  const key = `${accountId}:${calendarId}`;
  if (!shouldAttemptWatchRepair(lastWatchRepairAttempt.get(key), now)) {
    return;
  }
  lastWatchRepairAttempt.set(key, now);

  try {
    await enableWatch(env, accountId, calendarId, profileId);
  } catch (err) {
    // enableWatch は内部で失敗を飲み込み false を返す設計だが、念のため二重に守る
    // (ここでの失敗は best-effort であり /api/sync のレスポンスに影響させない)。
    console.warn(
      `watch self-repair failed (best-effort) for account=${accountId} calendar=${calendarId}`,
      err,
    );
  }
}

/** watch 解除。既に watch が無ければ何もしない。Google 側の停止に失敗してもローカルの行は削除する
 * (「監視を止めたい」というクライアントの意図を妨げる理由にはならない — revokeToken と同じ考え方)。 */
export async function disableWatch(env: Env, accountId: string, calendarId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT channel_id, resource_id FROM watches WHERE account_id = ? AND calendar_id = ?",
  )
    .bind(accountId, calendarId)
    .first<{ channel_id: string; resource_id: string | null }>();
  if (!row) return;

  if (row.resource_id) {
    try {
      const stub = env.USER_SYNC.getByName(accountId);
      const tokenResult = await stub.getValidAccessToken(accountId);
      if (tokenResult.ok) {
        await stopWatch(fetch, tokenResult.data, {
          channelId: row.channel_id,
          resourceId: row.resource_id,
        });
      }
    } catch (err) {
      console.warn(
        `watch stop failed (continuing to delete local row) for account=${accountId} calendar=${calendarId}`,
        err,
      );
    }
  }

  await env.DB.prepare("DELETE FROM watches WHERE channel_id = ?").bind(row.channel_id).run();
}
