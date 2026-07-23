import { describe, expect, it } from "vite-plus/test";
import { distinctIssueRepos, groupWorkLogsByIssue, issueTitleKey } from "./workLogGrouping";
import type { WorkLogDTO } from "@kichijitsu/shared";

function log(
  id: string,
  repo: string,
  startMs: number,
  endMs: number,
  overrides: Partial<WorkLogDTO> = {},
): WorkLogDTO {
  return {
    id,
    repo,
    startMs,
    endMs,
    ...overrides,
  };
}

describe("groupWorkLogsByIssue", () => {
  it("同一 repo+issue の記録を1グループにまとめ、合計/件数を出す", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000, { issueRef: "42" }),
      log("b", "owner/repo", 5_000, 6_500, { issueRef: "42" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(1);
    const g = groups[0];
    expect(g.repo).toBe("owner/repo");
    expect(g.issueRef).toBe("42");
    expect(g.sessionCount).toBe(2);
    // (2000-1000) + (6500-5000) = 1000 + 1500 = 2500
    expect(g.totalMs).toBe(2_500);
    expect(g.latestStartMs).toBe(5_000);
  });

  it("同じ repo でも issueRef が違えば別グループ", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000, { issueRef: "1" }),
      log("b", "owner/repo", 3_000, 4_000, { issueRef: "2" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(2);
    expect(new Set(groups.map((g) => g.issueRef))).toEqual(new Set(["1", "2"]));
  });

  it("issueRef 無し(undefined/空文字/空白)は repo 単位の『issue 無し』グループにまとまる", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000),
      log("b", "owner/repo", 3_000, 4_000, { issueRef: "" }),
      log("c", "owner/repo", 5_000, 6_000, { issueRef: "  " }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(1);
    expect(groups[0].issueRef).toBeUndefined();
    expect(groups[0].sessionCount).toBe(3);
  });

  it("issue 無しグループと issue 付きグループは同じ repo でも分かれる", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000),
      log("b", "owner/repo", 3_000, 4_000, { issueRef: "7" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(2);
    const noIssue = groups.find((g) => g.issueRef === undefined);
    const withIssue = groups.find((g) => g.issueRef === "7");
    expect(noIssue?.sessionCount).toBe(1);
    expect(withIssue?.sessionCount).toBe(1);
  });

  it("別 repo の同じ issueRef は別グループ", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo-a", 1_000, 2_000, { issueRef: "1" }),
      log("b", "owner/repo-b", 3_000, 4_000, { issueRef: "1" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(2);
    expect(new Set(groups.map((g) => g.repo))).toEqual(
      new Set(["owner/repo-a", "owner/repo-b"]),
    );
  });

  it("グループ内 logs は startMs 降順", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000, { issueRef: "1" }),
      log("b", "owner/repo", 9_000, 10_000, { issueRef: "1" }),
      log("c", "owner/repo", 5_000, 6_000, { issueRef: "1" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups[0].logs.map((l) => l.id)).toEqual(["b", "c", "a"]);
  });

  it("グループの並びは latestStartMs 降順", () => {
    const logs: WorkLogDTO[] = [
      // グループ1: 最新 startMs = 2_000
      log("a", "owner/repo", 1_000, 1_500, { issueRef: "1" }),
      log("b", "owner/repo", 2_000, 2_500, { issueRef: "1" }),
      // グループ2: 最新 startMs = 9_000
      log("c", "owner/repo", 9_000, 9_500, { issueRef: "2" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.map((g) => g.issueRef)).toEqual(["2", "1"]);
  });

  it("負や 0 の期間は totalMs に加算しない(Math.max(0, …))", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 5_000, 5_000, { issueRef: "1" }), // 0
      log("b", "owner/repo", 8_000, 7_000, { issueRef: "1" }), // 負
      log("c", "owner/repo", 1_000, 3_000, { issueRef: "1" }), // 2000
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups[0].totalMs).toBe(2_000);
    expect(groups[0].sessionCount).toBe(3);
  });

  it("issueRef が owner/repo#番号 の完全参照なら、作業 repo が違っても同じ issue にまとまる", () => {
    // MCP(claude-code)は issueRef に別 repo の issue を完全参照で入れる。実装した repo が
    // 違っても、同じ issue(scouty#33488)は1グループにまとめたい(今回のバグ修正)。
    const logs: WorkLogDTO[] = [
      log("a", "lapras-inc/lapras", 1_000, 2_000, { issueRef: "lapras-inc/scouty#33488" }),
      log("b", "lapras-inc/scouty", 3_000, 4_000, { issueRef: "lapras-inc/scouty#33488" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(1);
    expect(groups[0].repo).toBe("lapras-inc/scouty"); // 所属 repo(issue 側)
    expect(groups[0].issueRef).toBe("33488");
    expect(groups[0].sessionCount).toBe(2);
  });

  it("完全参照(owner/repo#番号)と素の番号が同じ issue を指すなら同一グループに正規化", () => {
    // UI タイマー/手動は作業 repo に対する素の番号、MCP は完全参照 — 同じ issue なら1つに。
    const logs: WorkLogDTO[] = [
      log("a", "lapras-inc/scouty", 1_000, 2_000, { issueRef: "33488" }),
      log("b", "lapras-inc/lapras", 3_000, 4_000, { issueRef: "lapras-inc/scouty#33488" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(1);
    expect(groups[0].repo).toBe("lapras-inc/scouty");
    expect(groups[0].issueRef).toBe("33488");
  });

  it("#番号(所属 repo なし)は作業 repo に対する番号として扱う", () => {
    const logs: WorkLogDTO[] = [
      log("a", "owner/repo", 1_000, 2_000, { issueRef: "#7" }),
      log("b", "owner/repo", 3_000, 4_000, { issueRef: "7" }),
    ];
    const groups = groupWorkLogsByIssue(logs);
    expect(groups.length).toBe(1);
    expect(groups[0].repo).toBe("owner/repo");
    expect(groups[0].issueRef).toBe("7");
  });

  it("空配列は空配列を返す", () => {
    expect(groupWorkLogsByIssue([])).toEqual([]);
  });
});

describe("issueTitleKey", () => {
  it("`${repo}#${number}` を組み立てる(number は数値でも文字列でも同じキー)", () => {
    expect(issueTitleKey("owner/repo", 42)).toBe("owner/repo#42");
    expect(issueTitleKey("owner/repo", "42")).toBe("owner/repo#42");
  });

  it("fetch 側(数値)とグループ側(文字列)で同じキーになる", () => {
    expect(issueTitleKey("lapras-inc/scouty", 33488)).toBe(
      issueTitleKey("lapras-inc/scouty", "33488"),
    );
  });
});

describe("distinctIssueRepos", () => {
  it("issue 付きグループの所属 repo を出現順で重複排除して返す", () => {
    const groups = groupWorkLogsByIssue([
      log("a", "owner/repo-a", 9_000, 9_500, { issueRef: "1" }),
      log("b", "owner/repo-a", 8_000, 8_500, { issueRef: "2" }),
      log("c", "owner/repo-b", 7_000, 7_500, { issueRef: "3" }),
    ]);
    expect(distinctIssueRepos(groups)).toEqual(["owner/repo-a", "owner/repo-b"]);
  });

  it("issue 無しグループ(issueRef undefined)は対象外", () => {
    const groups = groupWorkLogsByIssue([
      log("a", "owner/repo-a", 9_000, 9_500), // issue 無し
      log("b", "owner/repo-b", 8_000, 8_500, { issueRef: "5" }),
    ]);
    expect(distinctIssueRepos(groups)).toEqual(["owner/repo-b"]);
  });

  it("完全参照で正規化された所属 repo(作業 repo ではなく)を返す", () => {
    const groups = groupWorkLogsByIssue([
      log("a", "lapras-inc/lapras", 1_000, 2_000, { issueRef: "lapras-inc/scouty#33488" }),
    ]);
    expect(distinctIssueRepos(groups)).toEqual(["lapras-inc/scouty"]);
  });

  it("空配列は空配列を返す", () => {
    expect(distinctIssueRepos([])).toEqual([]);
  });
});
