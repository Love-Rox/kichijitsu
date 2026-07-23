import { describe, expect, it } from "vite-plus/test";
import type { GitHubWorkItemDTO, OpenWorkIntervalDTO } from "@kichijitsu/shared";
import type { PlannedBlock } from "../model/types";
import {
  buildTimerItemLookup,
  isIntervalRunning,
  openIntervalToTimeEntry,
  openIntervalsToTimeEntries,
} from "./openIntervals";

function interval(overrides: Partial<OpenWorkIntervalDTO> = {}): OpenWorkIntervalDTO {
  return {
    id: "wl:abc",
    repo: "owner/repo",
    issueRef: "42",
    startMs: 1_000,
    ...overrides,
  };
}

function queueItem(overrides: Partial<GitHubWorkItemDTO> = {}): GitHubWorkItemDTO {
  return {
    id: "gh:owner/repo:issue:42",
    type: "issue",
    kinds: [],
    title: "バグを直す",
    repo: "owner/repo",
    number: 42,
    url: "https://github.com/owner/repo/issues/42",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function planned(overrides: Partial<PlannedBlock> = {}): PlannedBlock {
  return {
    id: "plan:1",
    startMs: 0,
    endMs: 1000,
    linkedItemId: "gh:owner/repo:pr:7",
    itemType: "pr",
    title: "予定PR",
    repo: "owner/repo",
    number: 7,
    url: "https://github.com/owner/repo/pull/7",
    ...overrides,
  } as PlannedBlock;
}

describe("openIntervalToTimeEntry", () => {
  it("作業キューにメタがあれば linkedItemId/type/title/url を補完する", () => {
    const lookup = buildTimerItemLookup([], [queueItem()]);
    const e = openIntervalToTimeEntry(interval(), lookup);
    expect(e).toEqual({
      id: "wl:abc",
      linkedItemId: "gh:owner/repo:issue:42",
      itemType: "issue",
      title: "バグを直す",
      repo: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/issues/42",
      startMs: 1_000,
      endMs: null,
    });
  });

  it("メタが無い開区間(MCP 等)は id を linkedItemId に流用し repo/number にフォールバックする", () => {
    const e = openIntervalToTimeEntry(interval({ id: "wl:mcp", issueRef: "99" }), new Map());
    expect(e.linkedItemId).toBe("wl:mcp");
    expect(e.title).toBe("");
    expect(e.number).toBe(99);
    expect(e.url).toBe("https://github.com/owner/repo/issues/99");
    expect(e.endMs).toBeNull();
  });

  it("issueRef が無い(repo レベル)開区間は number=0 / repo URL にフォールバックする", () => {
    const e = openIntervalToTimeEntry(interval({ issueRef: undefined }), new Map());
    expect(e.number).toBe(0);
    expect(e.url).toBe("https://github.com/owner/repo");
  });

  it("id を TimeEntry.id にそのまま使う(ポーリングをまたいで安定=React key に使える)", () => {
    const e = openIntervalToTimeEntry(interval({ id: "wl:stable" }), new Map());
    expect(e.id).toBe("wl:stable");
  });
});

describe("buildTimerItemLookup", () => {
  it("同一 repo+number は作業キューが予定を上書きする(タイトルは最新の GitHub 側を優先)", () => {
    const lookup = buildTimerItemLookup(
      [planned({ linkedItemId: "gh:owner/repo:issue:42", number: 42, itemType: "issue", title: "古い予定タイトル" })],
      [queueItem({ title: "最新タイトル" })],
    );
    expect(lookup.get("owner/repo#42")?.title).toBe("最新タイトル");
  });

  it("作業キューに無く予定にだけある item もメタを引ける", () => {
    const lookup = buildTimerItemLookup([planned()], []);
    expect(lookup.get("owner/repo#7")).toEqual({
      linkedItemId: "gh:owner/repo:pr:7",
      itemType: "pr",
      title: "予定PR",
      url: "https://github.com/owner/repo/pull/7",
    });
  });
});

describe("openIntervalsToTimeEntries", () => {
  it("開区間の並び順を保って射影する", () => {
    const entries = openIntervalsToTimeEntries(
      [interval({ id: "a", issueRef: "42" }), interval({ id: "b", issueRef: "99" })],
      [],
      [queueItem()],
    );
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(entries[0]?.linkedItemId).toBe("gh:owner/repo:issue:42");
    expect(entries[1]?.linkedItemId).toBe("b"); // 99 はメタ無し
  });
});

describe("isIntervalRunning", () => {
  const intervals = [interval({ repo: "owner/repo", issueRef: "42" })];

  it("repo+number が一致すれば true", () => {
    expect(isIntervalRunning(intervals, "owner/repo", 42)).toBe(true);
  });

  it("number が違えば false", () => {
    expect(isIntervalRunning(intervals, "owner/repo", 7)).toBe(false);
  });

  it("repo が違えば false", () => {
    expect(isIntervalRunning(intervals, "owner/other", 42)).toBe(false);
  });

  it("type は問わない(issue/PR の区別なく repo+number で判定)", () => {
    // 開区間側に type が無いので、issue でも PR でも同じ repo+number なら実行中扱い
    expect(isIntervalRunning(intervals, "owner/repo", 42)).toBe(true);
  });
});
