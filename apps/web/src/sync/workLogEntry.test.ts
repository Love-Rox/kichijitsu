import { describe, expect, it } from "vite-plus/test";
import type { WorkLogDTO } from "@kichijitsu/shared";
import type { PlannedBlock } from "../model/types";
import { datetimeLocalValueToMs } from "./eventEdit";
import {
  buildWorkLogCreateRequest,
  collectWorkLogRepoCandidates,
  isManualWorkLog,
  validateWorkLogEntryForm,
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
