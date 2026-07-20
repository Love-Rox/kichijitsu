import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildWorkLogEvent,
  findOrCreateWorkLogCalendar,
  logWorkInterval,
  validateWorkLogInput,
  WORK_LOG_CALENDAR_SUMMARY,
  type WorkLogInput,
} from "../src/core/work-log";
import type { InsertEventCoreDeps } from "../src/core/insert-event";

const BASE_INPUT: WorkLogInput = {
  startIso: "2026-07-21T10:00:00Z",
  endIso: "2026-07-21T11:00:00Z",
  repo: "Love-Rox/kichijitsu",
};

describe("buildWorkLogEvent", () => {
  it("uses `repo#issueRef` as summary when issueRef is present", () => {
    const event = buildWorkLogEvent({ ...BASE_INPUT, issueRef: "42", branch: "feat/x" });
    expect(event.summary).toBe("Love-Rox/kichijitsu#42");
  });

  it("uses `repo (branch)` as summary when only branch is present", () => {
    const event = buildWorkLogEvent({ ...BASE_INPUT, branch: "feat/x" });
    expect(event.summary).toBe("Love-Rox/kichijitsu (feat/x)");
  });

  it("uses the bare repo as summary when neither issueRef nor branch is present", () => {
    const event = buildWorkLogEvent(BASE_INPUT);
    expect(event.summary).toBe("Love-Rox/kichijitsu");
  });

  it("always sets kichijitsuWorkLog and repo in extendedProperties.private", () => {
    const event = buildWorkLogEvent(BASE_INPUT);
    expect(event.extendedProperties.private).toEqual({
      kichijitsuWorkLog: "1",
      repo: "Love-Rox/kichijitsu",
    });
  });

  it("includes issueRef/branch/agent in extendedProperties.private only when provided", () => {
    const event = buildWorkLogEvent({
      ...BASE_INPUT,
      issueRef: "42",
      branch: "feat/x",
      agent: "claude-code",
    });
    expect(event.extendedProperties.private).toEqual({
      kichijitsuWorkLog: "1",
      repo: "Love-Rox/kichijitsu",
      issueRef: "42",
      branch: "feat/x",
      agent: "claude-code",
    });
  });

  it("sets transparency=transparent and visibility=private", () => {
    const event = buildWorkLogEvent(BASE_INPUT);
    expect(event.transparency).toBe("transparent");
    expect(event.visibility).toBe("private");
  });

  it("defaults timeZone to UTC when omitted", () => {
    const event = buildWorkLogEvent(BASE_INPUT);
    expect(event.start.timeZone).toBe("UTC");
    expect(event.end.timeZone).toBe("UTC");
  });

  it("passes through timeZone when provided", () => {
    const event = buildWorkLogEvent({ ...BASE_INPUT, timeZone: "Asia/Tokyo" });
    expect(event.start.timeZone).toBe("Asia/Tokyo");
    expect(event.end.timeZone).toBe("Asia/Tokyo");
  });

  it("assembles description lines from agent/branch/issueRef when present", () => {
    const event = buildWorkLogEvent({
      ...BASE_INPUT,
      agent: "claude-code",
      branch: "feat/x",
      issueRef: "42",
    });
    expect(event.description).toBe("agent: claude-code\nbranch: feat/x\nissue: #42");
  });

  it("produces an empty description when none of agent/branch/issueRef are present", () => {
    const event = buildWorkLogEvent(BASE_INPUT);
    expect(event.description).toBe("");
  });
});

describe("validateWorkLogInput", () => {
  it("returns missing_repo for an empty repo string", () => {
    expect(
      validateWorkLogInput({ startIso: BASE_INPUT.startIso, endIso: BASE_INPUT.endIso, repo: "" }),
    ).toBe("missing_repo");
  });

  it("returns missing_repo for a whitespace-only repo string", () => {
    expect(
      validateWorkLogInput({
        startIso: BASE_INPUT.startIso,
        endIso: BASE_INPUT.endIso,
        repo: "   ",
      }),
    ).toBe("missing_repo");
  });

  it("returns invalid_start for an unparseable start", () => {
    expect(
      validateWorkLogInput({ startIso: "not-a-date", endIso: BASE_INPUT.endIso, repo: "repo" }),
    ).toBe("invalid_start");
  });

  it("returns invalid_end for an unparseable end", () => {
    expect(
      validateWorkLogInput({ startIso: BASE_INPUT.startIso, endIso: "not-a-date", repo: "repo" }),
    ).toBe("invalid_end");
  });

  it("returns start_not_before_end when start === end", () => {
    expect(
      validateWorkLogInput({
        startIso: "2026-07-21T10:00:00Z",
        endIso: "2026-07-21T10:00:00Z",
        repo: "repo",
      }),
    ).toBe("start_not_before_end");
  });

  it("returns start_not_before_end when start > end", () => {
    expect(
      validateWorkLogInput({
        startIso: "2026-07-21T11:00:00Z",
        endIso: "2026-07-21T10:00:00Z",
        repo: "repo",
      }),
    ).toBe("start_not_before_end");
  });

  it("returns null for a valid input", () => {
    expect(validateWorkLogInput(BASE_INPUT)).toBeNull();
  });
});

function makeDeps(fetchImpl: typeof fetch): InsertEventCoreDeps {
  return {
    fetch: fetchImpl,
    getAccessToken: vi.fn(async () => "valid-access-token"),
    forceRefreshAccessToken: vi.fn(async () => "refreshed-access-token"),
  };
}

describe("findOrCreateWorkLogCalendar", () => {
  it("returns the existing calendar id without POSTing to /calendars when found", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            { id: "other-cal", summary: "Other" },
            { id: "work-log-cal", summary: WORK_LOG_CALENDAR_SUMMARY },
          ],
        }),
        { status: 200 },
      ),
    );
    const deps = makeDeps(fetchImpl);

    await expect(findOrCreateWorkLogCalendar(deps)).resolves.toBe("work-log-cal");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain("calendarList");
  });

  it("POSTs to /calendars and returns the new id when not found", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "other-cal", summary: "Other" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "new-work-log-cal" }), { status: 200 }),
      );
    const deps = makeDeps(fetchImpl);

    await expect(findOrCreateWorkLogCalendar(deps)).resolves.toBe("new-work-log-cal");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchImpl.mock.calls[1];
    expect(createUrl).toBe("https://www.googleapis.com/calendar/v3/calendars");
    const requestInit = createInit as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(requestInit.body as string)).toEqual({
      summary: WORK_LOG_CALENDAR_SUMMARY,
    });
  });
});

describe("logWorkInterval", () => {
  it("wires find-or-create + insert together end-to-end", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "new-work-log-cal" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "event-1" }), { status: 200 }));
    const deps = makeDeps(fetchImpl);

    await expect(logWorkInterval(deps, BASE_INPUT)).resolves.toEqual({
      calendarId: "new-work-log-cal",
      eventId: "event-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
