import { describe, expect, it } from "vite-plus/test";
import { hookActualByLinkedItem } from "./hookActual";
import type { Occurrence } from "../model/types";

let seq = 0;

function occ(overrides: Partial<Occurrence> & { workLog?: Occurrence["workLog"] }): Occurrence {
  seq += 1;
  return {
    id: `occ-${seq}`,
    seriesId: null,
    title: "kichijitsu 実績",
    startMs: 0,
    endMs: 3_600_000,
    color: "#000",
    source: "google",
    ...overrides,
  };
}

describe("hookActualByLinkedItem", () => {
  it("workLog を持たない occurrence は無視する", () => {
    const result = hookActualByLinkedItem([occ({})], ["ghq:owner/repo:issue:1"]);
    expect(result).toEqual({});
  });

  it("空の occurrences / plannedLinkedItemIds では空オブジェクトを返す", () => {
    expect(hookActualByLinkedItem([], [])).toEqual({});
  });

  it("repo+number(issueRef が数値)が一致する issue の linkedItemId に実績時間を足し込む", () => {
    const workLogOcc = occ({
      startMs: 0,
      endMs: 3_600_000, // 1h
      workLog: { repo: "owner/repo", issueRef: "42" },
    });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:issue:42"]);

    expect(result).toEqual({ "ghq:owner/repo:issue:42": 3_600_000 });
  });

  it("repo+number(issueRef が数値)が一致する pr の linkedItemId に実績時間を足し込む", () => {
    const workLogOcc = occ({
      startMs: 0,
      endMs: 1_800_000, // 30m
      workLog: { repo: "owner/repo", issueRef: "7" },
    });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:pr:7"]);

    expect(result).toEqual({ "ghq:owner/repo:pr:7": 1_800_000 });
  });

  it("同じ repo+number で issue と pr の両方が planned に存在する場合は両方に加算する", () => {
    const workLogOcc = occ({
      startMs: 0,
      endMs: 3_600_000,
      workLog: { repo: "owner/repo", issueRef: "5" },
    });

    const result = hookActualByLinkedItem(
      [workLogOcc],
      ["ghq:owner/repo:issue:5", "ghq:owner/repo:pr:5"],
    );

    expect(result).toEqual({
      "ghq:owner/repo:issue:5": 3_600_000,
      "ghq:owner/repo:pr:5": 3_600_000,
    });
  });

  it("repo が一致しても number が違えば集計対象外", () => {
    const workLogOcc = occ({ workLog: { repo: "owner/repo", issueRef: "42" } });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:issue:99"]);

    expect(result).toEqual({});
  });

  it("number が一致しても repo が違えば集計対象外", () => {
    const workLogOcc = occ({ workLog: { repo: "owner/other", issueRef: "42" } });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:issue:42"]);

    expect(result).toEqual({});
  });

  it("issueRef が非数値(ブランチ名由来等)の workLog occurrence は集計対象外", () => {
    const workLogOcc = occ({ workLog: { repo: "owner/repo", issueRef: "feat/foo" } });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({});
  });

  it("issueRef が無い workLog occurrence は集計対象外", () => {
    const workLogOcc = occ({ workLog: { repo: "owner/repo" } });

    const result = hookActualByLinkedItem([workLogOcc], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({});
  });

  it("同じ item への複数の hook 実績 occurrence は合算する", () => {
    const first = occ({
      startMs: 0,
      endMs: 1_800_000, // 30m
      workLog: { repo: "owner/repo", issueRef: "1" },
    });
    const second = occ({
      startMs: 10_000_000,
      endMs: 13_600_000, // 1h
      workLog: { repo: "owner/repo", issueRef: "1" },
    });

    const result = hookActualByLinkedItem([first, second], ["ghq:owner/repo:issue:1"]);

    expect(result).toEqual({ "ghq:owner/repo:issue:1": 5_400_000 });
  });

  it("plannedLinkedItemIds が ghq: 形式でない場合は無視する(異常値への防御)", () => {
    const workLogOcc = occ({ workLog: { repo: "owner/repo", issueRef: "1" } });

    const result = hookActualByLinkedItem([workLogOcc], ["not-a-ghq-id"]);

    expect(result).toEqual({});
  });
});
