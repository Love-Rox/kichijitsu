/**
 * 孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」、2026-08-04):
 * `GET /api/block-mirrors/orphans` (走査) と `POST /api/block-mirrors/cleanup` (削除)。
 *
 * ルール削除・target 変更・連携解除のいずれかで対応表 (block_mirrors) からはぐれ、コピー先
 * カレンダーに残り続ける「予定あり」ミラーを、対応表に頼らず target カレンダーの走査だけで
 * 見つけて片付ける独立した導線。判定ロジック本体は core/block-orphans.ts の
 * classifyMirrorState (純関数・単体テスト済み) にあり、ここでは D1/DO への薄い結線だけを行う。
 *
 * **削除は必ず再検証を経る**: POST /api/block-mirrors/cleanup は受け取った eventId を
 * そのまま信用せず、削除の直前に必ず events.get で取り直して「今も孤児と言えるか」を
 * classifyMirrorState に通す。理由は2つ:
 * - クライアントの一覧 (GET /api/block-mirrors/orphans の結果) は走査後に古くなりうる
 *   (削除しようとしている間にルールが作り直された、等)
 * - **ユーザーの予定を消す操作なので、クライアントの言い分を信用しない** ―― 他の書き戻し系
 *   (delete-event.ts 等) はクライアントの eventId を直接使うが、それらは「ユーザー自身が
 *   今まさに見ている予定」を対象にする一方、ここは以前の走査結果という間接的な入力を扱うため
 *   一段厳しくする
 */
import { Hono } from "hono";
import type {
  ApiError,
  BlockMirrorCleanupFailure,
  BlockMirrorCleanupRequest,
  BlockMirrorCleanupResponse,
  BlockMirrorOrphansResponse,
  BlockMirrorScanEntry,
  OrphanMirrorDTO,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import { denyUnlessAccountInProfile, INVALID_JSON, readJsonBody } from "./guards";
import {
  classifyMirrorState,
  extractOrphanMirrors,
  indexLiveRuleIds,
  isValidBlockMirrorCleanupRequest,
  isWritableCalendar,
  MAX_CLEANUP_ITEMS,
  type LiveMirrorRuleRef,
} from "../core/block-orphans";

export const blockMirrorsRoutes = new Hono<AppEnv>();

/** GET/POST 共通: このプロファイルの block_rules を LiveMirrorRuleRef[] の形で読む。 */
async function loadLiveRuleRefs(env: Env, profileId: string): Promise<LiveMirrorRuleRef[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, target_account_id, target_calendar_id FROM block_rules WHERE profile_id = ?",
  )
    .bind(profileId)
    .all<{ id: string; target_account_id: string; target_calendar_id: string }>();
  return results.map((row) => ({
    id: row.id,
    targetAccountId: row.target_account_id,
    targetCalendarId: row.target_calendar_id,
  }));
}

// このプロファイルの接続中アカウント全件の、書き込み可能な (accessRole owner/writer)
// カレンダーを走査する。コストは「アカウント数 (listCalendars 呼び出し) + 書き込み可能な
// カレンダー数 (scanMirrorEvents 呼び出し、各々ページング分もかかる)」。webhook/ポーリングの
// ような高頻度経路ではなく利用者が明示的に押す「掃除」ボタンからしか呼ばれない想定なので、
// 逐次実行 (Promise.all にしない) にして実装を単純に保つ ―― scanned/orphans の積み上げ順が
// 素直に決まり、1件の失敗を隣に波及させない best-effort ループとも相性がよい。
blockMirrorsRoutes.get("/api/block-mirrors/orphans", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;

  const { results: accountRows } = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE profile_id = ?",
  )
    .bind(profileId)
    .all<{ id: string }>();

  const liveRuleIds = indexLiveRuleIds(await loadLiveRuleRefs(c.env, profileId));

  const scanned: BlockMirrorScanEntry[] = [];
  const orphans: OrphanMirrorDTO[] = [];

  for (const account of accountRows) {
    const stub = c.env.USER_SYNC.getByName(account.id);
    const calendarsResult = await stub.listCalendars(account.id);
    if (!calendarsResult.ok) {
      // アカウント単位でカレンダー一覧すら取れない (トークン失効等)。scanned の1行は本来
      // カレンダー単位だが、この場合は calendarId が分からないので空文字で埋めて代表させる
      // (calendarSummary も同様) ―― 1アカウントの失敗が他のアカウントの走査を止めないための
      // best-effort 継続 (1カレンダーの走査失敗と同じ扱い)。
      scanned.push({
        accountId: account.id,
        calendarId: "",
        calendarSummary: "",
        ok: false,
        error: calendarsResult.error,
      });
      continue;
    }

    const writableCalendars = calendarsResult.data.filter(isWritableCalendar);

    for (const calendar of writableCalendars) {
      const eventsResult = await stub.scanMirrorEvents(account.id, calendar.id);
      if (!eventsResult.ok) {
        scanned.push({
          accountId: account.id,
          calendarId: calendar.id,
          calendarSummary: calendar.summary,
          ok: false,
          error: eventsResult.error,
        });
        continue;
      }
      scanned.push({
        accountId: account.id,
        calendarId: calendar.id,
        calendarSummary: calendar.summary,
        ok: true,
      });
      orphans.push(
        ...extractOrphanMirrors(account.id, calendar.id, eventsResult.data, liveRuleIds),
      );
    }
  }

  return c.json<BlockMirrorOrphansResponse>({ scanned, orphans });
});

// 削除は1件ずつ直列に処理する (block-orchestrate.ts の applyMirrorDeletions と同じ流儀 ――
// best-effort、1件の失敗が他を止めない)。各件で events.get (再検証) → 孤児と確認できた場合のみ
// events.delete、の最大2往復を行う。件数上限は core/block-orphans.ts の MAX_CLEANUP_ITEMS
// (500) のコメント参照。
blockMirrorsRoutes.post("/api/block-mirrors/cleanup", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  const body = await readJsonBody<BlockMirrorCleanupRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
  if (!isValidBlockMirrorCleanupRequest(body)) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }
  if (body.items.length === 0) {
    // 空配列は「消す対象が無い」という呼び出し側の状態異常 (呼ぶ意味が無い) なので、空振りの
    // 200 ではなく明示的な 400 にして呼び出し元にバグとして気付かせる。
    return c.json<ApiError>({ error: "empty_items" }, 400);
  }
  if (body.items.length > MAX_CLEANUP_ITEMS) {
    return c.json<ApiError>({ error: "too_many_items" }, 400);
  }

  // items が参照する accountId は全てこのプロファイルに属していること (他人のカレンダーの
  // 予定を消させないための検証)。denyUnlessAccountInProfile は1件ずつしか検証できないので、
  // 重複を除いてから回す。
  const accountIds = [...new Set(body.items.map((item) => item.accountId))];
  for (const accountId of accountIds) {
    const denied = await denyUnlessAccountInProfile(c, accountId);
    if (denied) return denied;
  }

  const liveRuleIds = indexLiveRuleIds(await loadLiveRuleRefs(c.env, profileId));

  let deleted = 0;
  const failed: BlockMirrorCleanupFailure[] = [];

  for (const item of body.items) {
    const stub = c.env.USER_SYNC.getByName(item.accountId);

    // 削除前に必ず取り直す ―― クライアントの一覧を信用しない (ファイル冒頭のコメント参照)。
    const eventResult = await stub.getEvent(item.accountId, item.calendarId, item.eventId);
    if (!eventResult.ok) {
      failed.push({ eventId: item.eventId, reason: `fetch_failed:${eventResult.error}` });
      continue;
    }
    if (eventResult.data === null) {
      // 走査後に (通常のリコンサイルや手動操作で) 既に消えていた。削除する必要が無いので、
      // 何もせず「削除しなかった」理由として報告するだけに留める。
      failed.push({ eventId: item.eventId, reason: "not_found" });
      continue;
    }

    const state = classifyMirrorState(item.accountId, item.calendarId, eventResult.data, liveRuleIds);
    if (state !== "orphan") {
      // not_a_mirror: 目印が無い (別の予定を指す eventId が渡された等)
      // cancelled: Google 上で既に削除済み (掃除の必要が無い)
      // alive: 対応するルールが (再) 作成されていた ―― リコンサイラの管轄に戻っている
      failed.push({ eventId: item.eventId, reason: `not_orphan:${state}` });
      continue;
    }

    const deleteResult = await stub.deleteEvent(item.accountId, item.calendarId, item.eventId);
    if (!deleteResult.ok) {
      failed.push({ eventId: item.eventId, reason: `delete_failed:${deleteResult.error}` });
      continue;
    }
    deleted += 1;
  }

  return c.json<BlockMirrorCleanupResponse>({ deleted, failed });
});
