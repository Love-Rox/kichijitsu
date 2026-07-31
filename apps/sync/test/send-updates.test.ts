import { describe, expect, it, vi } from "vite-plus/test";
import { createEventWithRetry } from "../src/core/create-event";
import { insertEventWithRetry } from "../src/core/insert-event";
import { patchEventRawWithRetry } from "../src/core/patch-event-raw";
import { DEFAULT_SEND_UPDATES } from "../src/core/patch-event";
import { buildMirrorEventBody } from "../src/core/block-reconcile";
import type { GoogleEventDTO } from "@kichijitsu/shared";

/**
 * **Google への書き込みは必ず sendUpdates を明示する**という不変条件 (2026-07-31)。
 *
 * 各 google/*.ts の型 (sendUpdates が必須) は「付け忘れ」をコンパイル時に止めるが、
 * **どの値が実際に飛ぶか**までは型では固定できない。ここで固めるのはそこ:
 *
 *  - patch/delete は既に `?sendUpdates=` を付けていたが、**mirror の時刻追従
 *    (patchEventRaw)・新規作成 (createEvent)・汎用 insert (insertEvent) の3経路は
 *    クエリを一切付けていなかった** ―― ゲストのいる予定に当たったとき誰にメールが飛ぶかが
 *    Google の未文書の既定次第、という穴が残っていた。
 *  - いずれの経路も現状は参加者を持たない body しか送らないので、この変更で利用者に
 *    見える挙動は変わらない (根拠は各 core/*.ts のコメント参照)。値を `all` ではなく
 *    kichijitsu 共通の既定 (externalOnly) にしてあるのは、「利用者が明示的に選んだときだけ
 *    全員へ知らせる」という規則を1本に保つため。
 */

/** insertEvent の実際の呼び出し元と同じ body (カレンダーブロックのミラー) を使う。 */
const SOURCE: GoogleEventDTO = {
  id: "ev-1",
  status: "confirmed",
  start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};
const MIRROR_BODY = buildMirrorEventBody(SOURCE, "busy", "rule-1");
const OOO_BODY = buildMirrorEventBody(SOURCE, "outOfOffice", "rule-1");

function makeDeps(fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken: vi.fn(async () => "refreshed-access-token"),
  };
}

/** fetch に渡った URL のクエリから sendUpdates を取り出す (無ければ null)。 */
function sentSendUpdates(fetchImpl: ReturnType<typeof vi.fn>, callIndex = 0): string | null {
  const url = new URL(fetchImpl.mock.calls[callIndex][0] as string);
  return url.searchParams.get("sendUpdates");
}

describe("Google への書き込みは sendUpdates を明示する", () => {
  it("createEventWithRetry (POST /api/event/create、MCP create_event)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new-event" }), { status: 200 }));

    await createEventWithRetry(makeDeps(fetchImpl), {
      calendarId: "primary",
      title: "打ち合わせ",
      startMs: 1_700_000_000_000,
      endMs: 1_700_003_600_000,
      timeZone: "Asia/Tokyo",
    });

    expect(sentSendUpdates(fetchImpl)).toBe(DEFAULT_SEND_UPDATES);
  });

  it("patchEventRawWithRetry (カレンダーブロックのミラー時刻追従)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await patchEventRawWithRetry(makeDeps(fetchImpl), {
      calendarId: "primary",
      eventId: "mirror-1",
      start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    });

    expect(sentSendUpdates(fetchImpl)).toBe(DEFAULT_SEND_UPDATES);
  });

  it("insertEventWithRetry (ミラー作成・作業実績)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-1" }), { status: 200 }));

    await insertEventWithRetry(makeDeps(fetchImpl), "primary", MIRROR_BODY);

    expect(sentSendUpdates(fetchImpl)).toBe(DEFAULT_SEND_UPDATES);
  });

  // OOO フォールバック (eventType を落として busy として作り直す) の再試行も同じ値で送る
  // ―― 「1回目は付いていたが再試行だけ付いていない」という穴を作らない。
  it("insertEventWithRetry の outOfOffice フォールバック再試行にも付く", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not supported", { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mirror-1" }), { status: 200 }));

    await insertEventWithRetry(makeDeps(fetchImpl), "primary", OOO_BODY);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sentSendUpdates(fetchImpl, 1)).toBe(DEFAULT_SEND_UPDATES);
  });
});
