import { describe, expect, it } from "vite-plus/test";
import type { WorkLogDTO } from "@kichijitsu/shared";
import type { PlannedBlock, TimeEntry } from "../model/types";
import { datetimeLocalValueToMs, msToDatetimeLocalValue } from "./eventEdit";
import {
  buildWorkLogCreateRequest,
  buildWorkLogUpdateRequest,
  collectWorkLogOrgCandidates,
  collectWorkLogRepoCandidates,
  combineOrgRepo,
  isManualWorkLog,
  validateWorkLogEntryForm,
  workLogRequestFromTimer,
  workLogToFormInput,
  type WorkLogEntryFormInput,
} from "./workLogEntry";

const TZ = "Asia/Tokyo";

const BASE_INPUT: WorkLogEntryFormInput = {
  repo: "Love-Rox/kichijitsu",
  issueRef: "",
  startLocal: "2026-07-21T10:00",
  endLocal: "2026-07-21T11:00",
  agent: "",
};

describe("validateWorkLogEntryForm", () => {
  it("returns missing_repo for an empty repo", () => {
    expect(validateWorkLogEntryForm({ ...BASE_INPUT, repo: "" }, TZ)).toBe("missing_repo");
  });

  it("returns missing_repo for a whitespace-only repo", () => {
    expect(validateWorkLogEntryForm({ ...BASE_INPUT, repo: "   " }, TZ)).toBe("missing_repo");
  });

  it("returns invalid_start for an empty start", () => {
    expect(validateWorkLogEntryForm({ ...BASE_INPUT, startLocal: "" }, TZ)).toBe("invalid_start");
  });

  it("returns invalid_end for an empty end", () => {
    expect(validateWorkLogEntryForm({ ...BASE_INPUT, endLocal: "" }, TZ)).toBe("invalid_end");
  });

  it("returns start_not_before_end when start === end", () => {
    expect(
      validateWorkLogEntryForm(
        { ...BASE_INPUT, startLocal: "2026-07-21T10:00", endLocal: "2026-07-21T10:00" },
        TZ,
      ),
    ).toBe("start_not_before_end");
  });

  it("returns start_not_before_end when start > end", () => {
    expect(
      validateWorkLogEntryForm(
        { ...BASE_INPUT, startLocal: "2026-07-21T11:00", endLocal: "2026-07-21T10:00" },
        TZ,
      ),
    ).toBe("start_not_before_end");
  });

  it("returns null for a valid input", () => {
    expect(validateWorkLogEntryForm(BASE_INPUT, TZ)).toBeNull();
  });
});

describe("buildWorkLogCreateRequest", () => {
  it("converts startLocal/endLocal (in the given timeZone) to ISO strings", () => {
    const req = buildWorkLogCreateRequest(BASE_INPUT, TZ);
    expect(req.start).toBe(
      new Date(datetimeLocalValueToMs(BASE_INPUT.startLocal, TZ)).toISOString(),
    );
    expect(req.end).toBe(new Date(datetimeLocalValueToMs(BASE_INPUT.endLocal, TZ)).toISOString());
  });

  it("produces different epoch instants for the same wall-clock value in different time zones", () => {
    const jstReq = buildWorkLogCreateRequest(BASE_INPUT, "Asia/Tokyo");
    const utcReq = buildWorkLogCreateRequest(BASE_INPUT, "UTC");
    expect(jstReq.start).not.toBe(utcReq.start);
  });

  it("trims and carries repo through", () => {
    const req = buildWorkLogCreateRequest({ ...BASE_INPUT, repo: "  owner/repo  " }, TZ);
    expect(req.repo).toBe("owner/repo");
  });

  it("omits issueRef/agent when blank", () => {
    const req = buildWorkLogCreateRequest(BASE_INPUT, TZ);
    expect(req.issueRef).toBeUndefined();
    expect(req.agent).toBeUndefined();
  });

  it("trims and includes issueRef/agent when provided", () => {
    const req = buildWorkLogCreateRequest(
      { ...BASE_INPUT, issueRef: "  42  ", agent: "  codex-cli  " },
      TZ,
    );
    expect(req.issueRef).toBe("42");
    expect(req.agent).toBe("codex-cli");
  });
});

describe("workLogToFormInput", () => {
  it("prefills repo/issueRef/agent and converts startMs/endMs to datetime-local values", () => {
    const startMs = datetimeLocalValueToMs("2026-07-21T10:00", TZ);
    const endMs = datetimeLocalValueToMs("2026-07-21T11:30", TZ);
    const input = workLogToFormInput(
      { id: "x", repo: "acme/web", issueRef: "42", agent: "claude-code", startMs, endMs },
      TZ,
    );
    expect(input).toEqual({
      repo: "acme/web",
      issueRef: "42",
      startLocal: msToDatetimeLocalValue(startMs, TZ),
      endLocal: msToDatetimeLocalValue(endMs, TZ),
      agent: "claude-code",
    });
  });

  it("maps missing issueRef/agent to empty strings", () => {
    const input = workLogToFormInput({ id: "x", repo: "acme/web", startMs: 0, endMs: 1 }, TZ);
    expect(input.issueRef).toBe("");
    expect(input.agent).toBe("");
  });

  it("round-trips through buildWorkLogUpdateRequest back to the same instants", () => {
    const startMs = datetimeLocalValueToMs("2026-07-21T10:00", TZ);
    const endMs = datetimeLocalValueToMs("2026-07-21T11:30", TZ);
    const req = buildWorkLogUpdateRequest(
      workLogToFormInput({ id: "x", repo: "acme/web", startMs, endMs }, TZ),
      TZ,
    );
    expect(req.start).toBe(new Date(startMs).toISOString());
    expect(req.end).toBe(new Date(endMs).toISOString());
  });
});

describe("buildWorkLogUpdateRequest", () => {
  it("always includes trimmed repo and ISO start/end", () => {
    const req = buildWorkLogUpdateRequest({ ...BASE_INPUT, repo: "  owner/repo  " }, TZ);
    expect(req.repo).toBe("owner/repo");
    expect(req.start).toBe(new Date(datetimeLocalValueToMs(BASE_INPUT.startLocal, TZ)).toISOString());
    expect(req.end).toBe(new Date(datetimeLocalValueToMs(BASE_INPUT.endLocal, TZ)).toISOString());
  });

  it("omits issueRef/agent when blank (kept unchanged server-side)", () => {
    const req = buildWorkLogUpdateRequest(BASE_INPUT, TZ);
    expect(req.issueRef).toBeUndefined();
    expect(req.agent).toBeUndefined();
  });

  it("trims and includes issueRef/agent when provided", () => {
    const req = buildWorkLogUpdateRequest(
      { ...BASE_INPUT, issueRef: "  7  ", agent: "  claude-code  " },
      TZ,
    );
    expect(req.issueRef).toBe("7");
    expect(req.agent).toBe("claude-code");
  });
});

describe("isManualWorkLog", () => {
  it("returns true when agent is 'manual'", () => {
    expect(isManualWorkLog({ agent: "manual" })).toBe(true);
  });

  it("returns false for a hook agent", () => {
    expect(isManualWorkLog({ agent: "claude-code" })).toBe(false);
  });

  it("returns false when agent is undefined", () => {
    expect(isManualWorkLog({ agent: undefined })).toBe(false);
  });
});

function workLog(overrides: Partial<WorkLogDTO> & { repo: string }): WorkLogDTO {
  return {
    id: "id",
    startMs: 0,
    endMs: 1,
    ...overrides,
  };
}

function plannedBlock(repo: string): PlannedBlock {
  return {
    id: `block-${repo}`,
    startMs: 0,
    endMs: 1,
    linkedItemId: `ghq:${repo}:issue:1`,
    itemType: "issue",
    title: "t",
    repo,
    number: 1,
    url: "https://example.com",
  };
}

describe("collectWorkLogRepoCandidates", () => {
  it("returns an empty array when there is nothing to collect from", () => {
    expect(collectWorkLogRepoCandidates([], [])).toEqual([]);
  });

  it("dedupes repos across workLogs and plannedBlocks", () => {
    const result = collectWorkLogRepoCandidates(
      [workLog({ repo: "a/repo" }), workLog({ repo: "b/repo" })],
      [plannedBlock("a/repo"), plannedBlock("c/repo")],
    );
    expect(result).toEqual(["a/repo", "b/repo", "c/repo"]);
  });

  it("sorts alphabetically", () => {
    const result = collectWorkLogRepoCandidates(
      [workLog({ repo: "z/repo" }), workLog({ repo: "a/repo" })],
      [],
    );
    expect(result).toEqual(["a/repo", "z/repo"]);
  });
});

describe("collectWorkLogOrgCandidates", () => {
  it("returns an empty array when there is nothing to collect from", () => {
    expect(collectWorkLogOrgCandidates([], [])).toEqual([]);
  });

  it("extracts and dedupes the org part across workLogs and plannedBlocks", () => {
    const result = collectWorkLogOrgCandidates(
      [workLog({ repo: "acme/web" }), workLog({ repo: "acme/api" })],
      [plannedBlock("beta/tool")],
    );
    expect(result).toEqual(["acme", "beta"]);
  });

  it("sorts alphabetically", () => {
    const result = collectWorkLogOrgCandidates(
      [workLog({ repo: "zeta/a" }), workLog({ repo: "alpha/b" })],
      [],
    );
    expect(result).toEqual(["alpha", "zeta"]);
  });

  it("ignores repos without an org part ('/'-less or leading-slash)", () => {
    const result = collectWorkLogOrgCandidates(
      [workLog({ repo: "standalone" }), workLog({ repo: "/leading" })],
      [],
    );
    expect(result).toEqual([]);
  });
});

describe("combineOrgRepo", () => {
  it("joins org and repo into 'org/repo'", () => {
    expect(combineOrgRepo("acme", "web")).toBe("acme/web");
  });

  it("trims both fields", () => {
    expect(combineOrgRepo("  acme  ", "  web  ")).toBe("acme/web");
  });

  it("returns an empty string when repo is blank (validation catches it)", () => {
    expect(combineOrgRepo("acme", "")).toBe("");
    expect(combineOrgRepo("acme", "   ")).toBe("");
  });

  it("uses repo alone when org is blank", () => {
    expect(combineOrgRepo("", "web")).toBe("web");
  });

  it("ignores org when repo already contains a slash (avoids double-join)", () => {
    expect(combineOrgRepo("acme", "beta/web")).toBe("beta/web");
  });
});

describe("workLogRequestFromTimer", () => {
  const STOPPED: TimeEntry = {
    id: "te:ghq:owner/repo:issue:42:1000",
    linkedItemId: "ghq:owner/repo:issue:42",
    itemType: "issue",
    title: "バグを直す",
    repo: "owner/repo",
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    startMs: Date.UTC(2026, 6, 23, 1, 0, 0),
    endMs: Date.UTC(2026, 6, 23, 2, 30, 0),
  };

  it("converts start/end epoch ms to UTC ISO strings", () => {
    const req = workLogRequestFromTimer(STOPPED);
    expect(req.start).toBe("2026-07-23T01:00:00.000Z");
    expect(req.end).toBe("2026-07-23T02:30:00.000Z");
  });

  it("carries repo through and stringifies number into issueRef", () => {
    const req = workLogRequestFromTimer(STOPPED);
    expect(req.repo).toBe("owner/repo");
    expect(req.issueRef).toBe("42");
  });

  it('tags the request with agent "timer"', () => {
    expect(workLogRequestFromTimer(STOPPED).agent).toBe("timer");
  });

  it("throws when the entry is still running (endMs === null)", () => {
    expect(() => workLogRequestFromTimer({ ...STOPPED, endMs: null })).toThrow();
  });
});
