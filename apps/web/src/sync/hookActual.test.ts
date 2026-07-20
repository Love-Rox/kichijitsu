import { describe, expect, it } from "vite-plus/test";
import { hookActualByLinkedItem } from "./hookActual";
import type { WorkLogDTO } from "@kichijitsu/shared";

let seq = 0;

function workLog(overrides: Partial<WorkLogDTO> & { repo: string }): WorkLogDTO {
  seq += 1;
  return {
    id: `work-log-${seq}`,
    startMs: 0,
    endMs: 3_600_000,
    ...overrides,
  };
}

describe("hookActualByLinkedItem", () => {
  it("issueRef を持たない workLog は無視する", () => {
    const result = hookActualByLinkedItem(
      [workLog({ repo: "owner/repo" })],
      ["ghq:owner/repo:issue:1"],
    );
    expect(result).toEqual({});
  });

  it("空の workLogs / plannedLinkedItemIds では空オブジェクトを返す", () => {
    expect(hookActualByLinkedItem([], [])).toEqual({});
  });

  it("repo+number(issueRef が数値)が一致する issue の linkedItemId に実績時間を足し込む", () => {
    const entry = workLog({
      startMs: 0,
      endMs: 3_600_000, // 1h
      repo: "owner/repo",
      issueRef: "42",
    });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:42"]);

    expect(result).toEqual({ "ghq:owner/repo:issue:42": 3_600_000 });
  });

  it("repo+number(issueRef が数値)が一致する pr の linkedItemId に実績時間を足し込む", () => {
    const entry = workLog({
      startMs: 0,
      endMs: 1_800_000, // 30m
      repo: "owner/repo",
      issueRef: "7",
    });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:pr:7"]);

    expect(result).toEqual({ "ghq:owner/repo:pr:7": 1_800_000 });
  });

  it("同じ repo+number で issue と pr の両方が planned に存在する場合は両方に加算する", () => {
    const entry = workLog({
      startMs: 0,
      endMs: 3_600_000,
      repo: "owner/repo",
      issueRef: "5",
    });

    const result = hookActualByLinkedItem(
      [entry],
      ["ghq:owner/repo:issue:5", "ghq:owner/repo:pr:5"],
    );

    expect(result).toEqual({
      "ghq:owner/repo:issue:5": 3_600_000,
      "ghq:owner/repo:pr:5": 3_600_000,
    });
  });

  it("repo が一致しても number が違えば集計対象外", () => {
    const entry = workLog({ repo: "owner/repo", issueRef: "42" });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:99"]);

    expect(result).toEqual({});
  });

  it("number が一致しても repo が違えば集計対象外", () => {
    const entry = workLog({ repo: "owner/other", issueRef: "42" });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:42"]);

    expect(result).toEqual({});
  });

  it("issueRef が非数値(ブランチ名由来等)の workLog は集計対象外", () => {
    const entry = workLog({ repo: "owner/repo", issueRef: "feat/foo" });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({});
  });

  it("issueRef が無い workLog は集計対象外", () => {
    const entry = workLog({ repo: "owner/repo" });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({});
  });

  it("同じ item への複数の hook 実績 workLog は合算する", () => {
    const first = workLog({
      startMs: 0,
      endMs: 1_800_000, // 30m
      repo: "owner/repo",
      issueRef: "1",
    });
    const second = workLog({
      startMs: 10_000_000,
      endMs: 13_600_000, // 1h
      repo: "owner/repo",
      issueRef: "1",
    });

    const result = hookActualByLinkedItem([first, second], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({ "ghq:owner/repo:issue:1": 5_400_000 });
  });

  it("plannedLinkedItemIds が ghq: 形式でない場合は無視する(異常値への防御)", () => {
    const entry = workLog({ repo: "owner/repo", issueRef: "1" });

    const result = hookActualByLinkedItem([entry], ["not-a-ghq-id"]);

    expect(result).toEqual({});
  });
});
