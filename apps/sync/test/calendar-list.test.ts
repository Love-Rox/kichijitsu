import { describe, expect, it, vi } from "vite-plus/test";
import { fetchCalendarList, parseCalendarList } from "../src/google/calendar-list";
import { listCalendarsWithRetry, type CalendarListCoreDeps } from "../src/core/calendar-list";

/**
 * カレンダー一覧 (`GET /api/calendars`) の層分担と 401 リトライ (2026-07-31)。
 *
 * ここで固めているのは**振る舞いの変更**そのもの: それまで google/calendar-list.ts は
 * 自分で GoogleApiError を投げて JSON をパースしており (他の google/*.ts は「Response を
 * そのまま返し、core が status を見る」約束)、その結果カレンダー一覧は **kichijitsu で
 * 唯一 401 リトライの効かない Google 呼び出し**だった。DO のトークンキャッシュが切れた
 * 瞬間に当たると、他の同期は自力で回復するのにここだけ 401 で落ちる。
 */

const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

const RAW_LIST = {
  items: [
    {
      id: "primary",
      summary: "メイン",
      primary: true,
      backgroundColor: "#123456",
      accessRole: "owner",
      defaultReminders: [
        { method: "popup", minutes: 10 },
        // popup 以外は落ちる (derivePopupReminderMinutes)
        { method: "email", minutes: 60 },
      ],
    },
    { id: "holidays", summary: "祝日" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeDeps(fetchImpl: typeof fetch) {
  const forceRefreshAccessToken = vi.fn(async () => "refreshed-access-token");
  const deps: CalendarListCoreDeps = {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken,
  };
  return { deps, forceRefreshAccessToken };
}

describe("fetchCalendarList", () => {
  it("GETs calendarList with a bearer auth header", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(RAW_LIST));

    await fetchCalendarList(fetchImpl, "access-token");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CALENDAR_LIST_URL);
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer access-token",
    );
  });

  // 層の約束: google/*.ts は throw せず Response をそのまま返し、status の解釈は core が行う。
  it("returns the response as-is without throwing on an error status", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const response = await fetchCalendarList(fetchImpl, "access-token");

    expect(response.status).toBe(403);
  });
});

describe("parseCalendarList", () => {
  it("maps entries and keeps popup-only default reminders (empty array included)", async () => {
    expect(await parseCalendarList(jsonResponse(RAW_LIST))).toEqual([
      {
        id: "primary",
        summary: "メイン",
        primary: true,
        backgroundColor: "#123456",
        accessRole: "owner",
        defaultReminderMinutes: [10],
      },
      {
        id: "holidays",
        summary: "祝日",
        primary: undefined,
        backgroundColor: undefined,
        accessRole: undefined,
        // 既定リマインダーが無いカレンダーも空配列として載る (「未取得」と区別する)
        defaultReminderMinutes: [],
      },
    ]);
  });
});

describe("listCalendarsWithRetry", () => {
  it("returns the parsed list on success", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(RAW_LIST));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    const list = await listCalendarsWithRetry(deps);

    expect(list.map((entry) => entry.id)).toEqual(["primary", "holidays"]);
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
  });

  // 本題: 401 は 1 回だけ強制リフレッシュして再試行する (他の Google 呼び出しと同じ)。
  it("force-refreshes the token once on 401 and retries with the new token", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse(RAW_LIST));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    const list = await listCalendarsWithRetry(deps);

    expect(list.map((entry) => entry.id)).toEqual(["primary", "holidays"]);
    expect(forceRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchImpl.mock.calls[1];
    expect(((secondInit as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer refreshed-access-token",
    );
  });

  // リトライは 1 回だけ (無限ループしない)。
  it("throws GoogleApiError when the retry is also 401", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const { deps } = makeDeps(fetchImpl);

    await expect(listCalendarsWithRetry(deps)).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws GoogleApiError without retrying on non-401 failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { deps, forceRefreshAccessToken } = makeDeps(fetchImpl);

    await expect(listCalendarsWithRetry(deps)).rejects.toThrow(/403/);
    expect(forceRefreshAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
