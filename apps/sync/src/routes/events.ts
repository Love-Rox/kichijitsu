/**
 * 予定の同期と書き戻し、およびリアルタイム通知の `/api/sync`・`/api/event/*`・`/api/events` (SSE)。
 * routes/api.ts から分割 (2026-07-25) — 挙動は変えていない。
 *
 * 書き戻し系 (patch/rsvp/create/delete) の共通方針: 結果はレスポンスで返さず ok のみ。正本は次の
 * 同期 (webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する設計であり、
 * 失敗理由は一律 409 (rsvp の not_an_attendee のみ 422) にマップして、理由ごとの分岐を
 * クライアントに要求しない。
 */
import { Hono } from "hono";
import type {
  ApiError,
  EventCreateRequest,
  EventCreateResponse,
  EventDeleteRequest,
  EventDeleteResponse,
  EventPatchRequest,
  EventPatchResponse,
  EventRsvpRequest,
  EventRsvpResponse,
  SyncRequest,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import { isAccountInProfile } from "../accounts";
import { isValidEventCreateRequest } from "../core/create-event";
import { respondFromRpcResult } from "./respond";
import { repairWatchIfNeeded } from "../watch-registration";
import { PROFILE_ID_HEADER } from "../durable-object/profile-hub-protocol";

export const eventRoutes = new Hono<AppEnv>();

eventRoutes.post("/api/sync", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: SyncRequest;
  try {
    body = await c.req.json<SyncRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.calendarId) {
    return c.json<ApiError>({ error: "missing_accountId_or_calendarId" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.sync(body.accountId, body.calendarId, body.deviceId, body.forceFull);
  if (result.ok) {
    // watch 自己修復 (best-effort)。正経路は選択トグル時の POST /api/watch のみなので、
    // watches 行の消失/取り違え (プロファイル作り直し事故など) を放置すると手動でトグルし
    // 直すまで直らない — ここで同期成功のたびに検知して直す。レスポンスはブロックしない。
    c.executionCtx.waitUntil(
      repairWatchIfNeeded(c.env, body.accountId, body.calendarId, profileId, Date.now()),
    );
  }
  return respondFromRpcResult(c, result);
});

// 予定の変更を Google へ書き戻す (フェーズ5、2026-07-22 全項目編集に拡張)。書き込み結果は
// レスポンスで返さない (ok のみ) — 正本は次の同期 (webhook/ポーリング → SSE 'changed' →
// クライアントの /api/sync) で還流する設計であり、ここで Google の応答をクライアントへ
// 整形して返すことはしない。失敗理由 (404/403/412/401 リトライ失敗など) は問わず一律 409 に
// マップする: クライアントはこれを「反映できなかった」信号としてローカルの
// 楽観更新をロールバックすればよく、理由ごとの分岐を必要としない。
// summary/location/description/isAllDay は optional — 未指定の旧クライアント (時刻のみ
// 送るリクエスト) もそのまま動く (後方互換)。指定された場合のみ型チェックする
// (undefined を許容しつつ、指定した値の型は誤りを弾く)。
eventRoutes.post("/api/event/patch", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventPatchRequest;
  try {
    body = await c.req.json<EventPatchRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.calendarId ||
    !body?.eventId ||
    typeof body.startMs !== "number" ||
    typeof body.endMs !== "number" ||
    !body?.timeZone ||
    (body.summary !== undefined && typeof body.summary !== "string") ||
    (body.location !== undefined && typeof body.location !== "string") ||
    (body.description !== undefined && typeof body.description !== "string") ||
    (body.isAllDay !== undefined && typeof body.isAllDay !== "boolean")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.patchEvent(
    body.accountId,
    body.calendarId,
    body.eventId,
    body.startMs,
    body.endMs,
    body.timeZone,
    {
      summary: body.summary,
      location: body.location,
      description: body.description,
      isAllDay: body.isAllDay,
    },
  );
  if (!result.ok) {
    console.warn(
      `event patch failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "patch_failed" }, 409);
  }

  return c.json<EventPatchResponse>({ ok: true });
});

// 自分の参加ステータス (RSVP) を Google へ書き戻す (2026-07-22)。認可チェック
// (requireAuth + isAccountInProfile) は /api/event/patch と同じ。responseStatus は
// Google の4値のみ許可する。self attendee が見つからない予定は RpcResult.error ===
// "not_an_attendee" (core/rsvp-event.ts → NotAnAttendeeError → rpc-result.ts) として
// 422 で明確に区別して返す — それ以外の失敗は /api/event/patch と同じ一律 409
// (理由ごとの分岐をクライアントに要求しない方針)。
eventRoutes.post("/api/event/rsvp", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventRsvpRequest;
  try {
    body = await c.req.json<EventRsvpRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (
    !body?.accountId ||
    !body?.calendarId ||
    !body?.eventId ||
    (body.responseStatus !== "accepted" &&
      body.responseStatus !== "declined" &&
      body.responseStatus !== "tentative" &&
      body.responseStatus !== "needsAction")
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.rsvpEvent(
    body.accountId,
    body.calendarId,
    body.eventId,
    body.responseStatus,
  );
  if (!result.ok) {
    console.warn(
      `event rsvp failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    if (result.error === "not_an_attendee") {
      return c.json<ApiError>({ error: "not_an_attendee" }, 422);
    }
    return c.json<ApiError>({ error: "rsvp_failed" }, 409);
  }

  return c.json<EventRsvpResponse>({ ok: true });
});

// 新規予定を Google へ作成する (フェーズ5、2026-07-29 全項目入力に拡張)。エラーの一律 409
// マッピング方針は /api/event/patch と同じ (コメント参照)。成功時は eventId のみ返す — UI が
// 楽観的 occurrence の id を確定 id に差し替えるためであり、それ以外の作成結果 (実際の start/end 等)
// を正本として返すことはしない。正本は次の同期 (webhook/ポーリング → SSE 'changed' →
// クライアントの /api/sync) で還流する。
//
// ボディ検証は core/create-event.ts の isValidEventCreateRequest (純関数・テストあり) に
// 出してある — /api/event/patch のようなインラインの条件式に location/description/isAllDay の
// 型と長さ、開始<終了 の整合まで足すと読めなくなるため (block-rules の
// isValidBlockRuleUpsertRequest と同じ流儀)。location/description/isAllDay は optional なので
// 未指定の旧クライアント (タイトルと時間帯だけ送るリクエスト) もそのまま通る (後方互換)。
eventRoutes.post("/api/event/create", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: unknown;
  try {
    body = await c.req.json<EventCreateRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!isValidEventCreateRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.createEvent(
    body.accountId,
    body.calendarId,
    body.title,
    body.startMs,
    body.endMs,
    body.timeZone,
    {
      location: body.location,
      description: body.description,
      isAllDay: body.isAllDay,
    },
  );
  if (!result.ok) {
    console.warn(
      `event create failed: account=${body.accountId} calendar=${body.calendarId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "create_failed" }, 409);
  }

  return c.json<EventCreateResponse>({ ok: true, eventId: result.data });
});

// 予定を Google から削除する (フェーズ5)。404 (既に削除済み) は UserSyncDO.deleteEvent /
// deleteEventWithRetry の中で成功扱いにしている (冪等) ので、ここに届く時点で ok:false は
// 本当の失敗 (403/412/5xx や 401 リトライ失敗) のみ。エラーの一律 409 マッピング方針は
// /api/event/patch と同じ (コメント参照)。
eventRoutes.post("/api/event/delete", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  let body: EventDeleteRequest;
  try {
    body = await c.req.json<EventDeleteRequest>();
  } catch {
    return c.json<ApiError>({ error: "invalid_json" }, 400);
  }
  if (!body?.accountId || !body?.calendarId || !body?.eventId) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  const account = await c.env.DB.prepare("SELECT profile_id FROM accounts WHERE id = ?")
    .bind(body.accountId)
    .first<{ profile_id: string }>();
  if (!isAccountInProfile(account, profileId)) {
    return c.json<ApiError>({ error: "account_not_found" }, 403);
  }

  const stub = c.env.USER_SYNC.getByName(body.accountId);
  const result = await stub.deleteEvent(body.accountId, body.calendarId, body.eventId);
  if (!result.ok) {
    console.warn(
      `event delete failed: account=${body.accountId} calendar=${body.calendarId} event=${body.eventId} status=${result.status} error=${result.error}`,
    );
    return c.json<ApiError>({ error: "delete_failed" }, 409);
  }

  return c.json<EventDeleteResponse>({ ok: true });
});

// リアルタイム反映用の SSE ストリーム。通知はトリガーに過ぎず、データそのものは運ばない
// (クライアントは 'changed' を受けたら該当 accountId/calendarId を /api/sync で取りに行く)。
// ProfileHubDO 自身は自分の名前 (profileId) を知らないので、転送時にヘッダで明示的に渡す。
// settings.ts ではなくここに置くのは、POST /api/sync と同じ realtime→/api/sync の配管の
// 一部だから (SSE の 'changed' 通知がクライアントに /api/sync を叩かせる起点になる)。
eventRoutes.get("/api/events", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const stub = c.env.PROFILE_HUB.getByName(profileId);
  const headers = new Headers(c.req.raw.headers);
  headers.set(PROFILE_ID_HEADER, profileId);
  const forwarded = new Request(c.req.raw, { headers });
  return stub.fetch(forwarded);
});
