import { describe, expect, it } from "vite-plus/test";
import {
  aggregateWorkLogs,
  buildWorkLogRow,
  NO_ISSUE_LABEL,
  validateWorkLogInput,
  type WorkLogInput,
  type WorkLogListRow,
} from "../src/core/work-log";

const BASE_INPUT: WorkLogInput = {
  startIso: "2026-07-21T10:00:00Z",
  endIso: "2026-07-21T11:00:00Z",
  repo: "Love-Rox/kichijitsu",
};

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

describe("buildWorkLogRow", () => {
  it("parses startIso/endIso into epoch ms", () => {
    const row = buildWorkLogRow("row-1", "profile-1", BASE_INPUT, 1_000);
    expect(row.startMs).toBe(Date.parse(BASE_INPUT.startIso));
    expect(row.endMs).toBe(Date.parse(BASE_INPUT.endIso));
  });

  it("carries through id/profileId/now as given", () => {
    const row = buildWorkLogRow("row-1", "profile-1", BASE_INPUT, 1_000);
    expect(row.id).toBe("row-1");
    expect(row.profileId).toBe("profile-1");
    expect(row.createdAt).toBe(1_000);
  });

  it("carries through repo always, and branch/issueRef/agent only when provided", () => {
    const bare = buildWorkLogRow("row-1", "profile-1", BASE_INPUT, 1_000);
    expect(bare.repo).toBe("Love-Rox/kichijitsu");
    expect(bare.branch).toBeUndefined();
    expect(bare.issueRef).toBeUndefined();
    expect(bare.agent).toBeUndefined();

    const full = buildWorkLogRow(
      "row-2",
      "profile-1",
      { ...BASE_INPUT, branch: "feat/x", issueRef: "42", agent: "claude-code" },
      1_000,
    );
    expect(full.branch).toBe("feat/x");
    expect(full.issueRef).toBe("42");
    expect(full.agent).toBe("claude-code");
  });
});

function row(overrides: Partial<WorkLogListRow> & { id: string }): WorkLogListRow {
  return {
    repo: "Love-Rox/kichijitsu",
    issue_ref: null,
    branch: null,
    agent: null,
    start_ms: 0,
    end_ms: 60_000,
    ...overrides,
  };
}

describe("aggregateWorkLogs", () => {
  it("returns an empty array for no rows", () => {
    expect(aggregateWorkLogs([])).toEqual([]);
  });

  it("groups rows by repo + issueRef and sums totalMs/count", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", issue_ref: "42", start_ms: 0, end_ms: 60_000 }),
      row({ id: "2", issue_ref: "42", start_ms: 100_000, end_ms: 160_000 }),
    ];
    const result = aggregateWorkLogs(rows);
    expect(result).toEqual([
      { repo: "Love-Rox/kichijitsu", issueRef: "42", totalMs: 120_000, count: 2 },
    ]);
  });

  it("keeps rows with different repos/issueRefs in separate groups", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", repo: "Love-Rox/kichijitsu", issue_ref: "1", start_ms: 0, end_ms: 60_000 }),
      row({
        id: "2",
        repo: "Love-Rox/kichijitsu",
        issue_ref: "2",
        start_ms: 0,
        end_ms: 60_000,
      }),
      row({ id: "3", repo: "Love-Rox/other", issue_ref: "1", start_ms: 0, end_ms: 60_000 }),
    ];
    expect(aggregateWorkLogs(rows)).toHaveLength(3);
  });

  it("groups rows with a null issue_ref under NO_ISSUE_LABEL", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", issue_ref: null, start_ms: 0, end_ms: 60_000 }),
      row({ id: "2", issue_ref: null, start_ms: 60_000, end_ms: 120_000 }),
    ];
    const result = aggregateWorkLogs(rows);
    expect(result).toEqual([
      { repo: "Love-Rox/kichijitsu", issueRef: NO_ISSUE_LABEL, totalMs: 120_000, count: 2 },
    ]);
  });

  it("sorts groups by totalMs descending", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", issue_ref: "small", start_ms: 0, end_ms: 60_000 }),
      row({ id: "2", issue_ref: "big", start_ms: 0, end_ms: 600_000 }),
      row({ id: "3", issue_ref: "medium", start_ms: 0, end_ms: 300_000 }),
    ];
    expect(aggregateWorkLogs(rows).map((item) => item.issueRef)).toEqual([
      "big",
      "medium",
      "small",
    ]);
  });

  it("breaks totalMs ties by repo then issueRef ascending", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", repo: "b-repo", issue_ref: "1", start_ms: 0, end_ms: 60_000 }),
      row({ id: "2", repo: "a-repo", issue_ref: "2", start_ms: 0, end_ms: 60_000 }),
      row({ id: "3", repo: "a-repo", issue_ref: "1", start_ms: 0, end_ms: 60_000 }),
    ];
    const result = aggregateWorkLogs(rows);
    expect(result.map((item) => `${item.repo}/${item.issueRef}`)).toEqual([
      "a-repo/1",
      "a-repo/2",
      "b-repo/1",
    ]);
  });

  it("excludes rows where start_ms >= end_ms from both totalMs and count", () => {
    const rows: WorkLogListRow[] = [
      row({ id: "1", issue_ref: "42", start_ms: 0, end_ms: 60_000 }),
      row({ id: "2", issue_ref: "42", start_ms: 60_000, end_ms: 60_000 }), // start === end
      row({ id: "3", issue_ref: "42", start_ms: 200_000, end_ms: 100_000 }), // start > end
    ];
    expect(aggregateWorkLogs(rows)).toEqual([
      { repo: "Love-Rox/kichijitsu", issueRef: "42", totalMs: 60_000, count: 1 },
    ]);
  });

  it("omits a group entirely when all of its rows are invalid", () => {
    const rows: WorkLogListRow[] = [row({ id: "1", issue_ref: "42", start_ms: 60_000, end_ms: 0 })];
    expect(aggregateWorkLogs(rows)).toEqual([]);
  });
});
