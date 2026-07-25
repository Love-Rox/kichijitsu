import { describe, expect, it } from "vite-plus/test";
import { hookActualByLinkedItem, workLogItemRef } from "./hookActual";
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

  it("issueRef が `owner/repo#番号` の完全参照なら issue の所属 repo 側の item に足し込む", () => {
    // 実装は owner/impl、issue は owner/spec に立っているケース(hook/MCP が書く形)。
    // 実績履歴のグループ化 (workLogGrouping.ts) と同じ正規化を使う。
    const entry = workLog({ repo: "owner/impl", issueRef: "owner/spec#3", endMs: 1_800_000 });

    const result = hookActualByLinkedItem([entry], [
      "ghq:owner/spec:issue:3",
      "ghq:owner/impl:issue:3",
    ]);

    expect(result).toEqual({ "ghq:owner/spec:issue:3": 1_800_000 });
  });

  it("issueRef が `#番号` なら作業 repo に対する相対番号として突き合わせる", () => {
    const entry = workLog({ repo: "owner/repo", issueRef: "#9", endMs: 1_800_000 });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:issue:9"]);

    expect(result).toEqual({ "ghq:owner/repo:issue:9": 1_800_000 });
  });

  it("issueRef が桁揃え(先頭ゼロ)でも同じ番号として突き合わせる", () => {
    const entry = workLog({ repo: "owner/repo", issueRef: "007", endMs: 1_800_000 });

    const result = hookActualByLinkedItem([entry], ["ghq:owner/repo:pr:7"]);

    expect(result).toEqual({ "ghq:owner/repo:pr:7": 1_800_000 });
  });
});

describe("workLogItemRef", () => {
  it("素の数値 issueRef は作業 repo + 番号になる", () => {
    expect(workLogItemRef({ repo: "owner/repo", issueRef: "42" })).toEqual({
      repo: "owner/repo",
      number: 42,
    });
  });

  it("`owner/repo#番号` の完全参照は issue の所属 repo になる", () => {
    expect(workLogItemRef({ repo: "owner/impl", issueRef: "owner/spec#3" })).toEqual({
      repo: "owner/spec",
      number: 3,
    });
  });

  it("issueRef 無し・非数値・空白のみは null(item に紐づけられない)", () => {
    expect(workLogItemRef({ repo: "owner/repo" })).toBeNull();
    expect(workLogItemRef({ repo: "owner/repo", issueRef: "feat/foo" })).toBeNull();
    expect(workLogItemRef({ repo: "owner/repo", issueRef: "  " })).toBeNull();
  });
});
