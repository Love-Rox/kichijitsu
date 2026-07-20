import { describe, expect, it } from "vite-plus/test";
import { buildWorkLogRow, validateWorkLogInput, type WorkLogInput } from "../src/core/work-log";

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
