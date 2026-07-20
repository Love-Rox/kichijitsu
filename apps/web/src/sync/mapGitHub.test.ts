import { describe, expect, it } from "vite-plus/test";
import type { GitHubItemDTO } from "@kichijitsu/shared";
import type { GitHubItem } from "../model/types";
import {
  GITHUB_MAX_VISIBLE_MILESTONES,
  groupGitHubItemsByMilestone,
  layoutGitHubDay,
  mapGitHubItems,
} from "./mapGitHub";

function milestone(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    id: "gh:acme/repo:milestone:1",
    type: "milestone",
    title: "v1.0",
    dateMs: Date.UTC(2026, 6, 20),
    repo: "acme/repo",
    number: 1,
    url: "https://github.com/acme/repo/milestone/1",
    ...overrides,
  };
}

function child(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    id: "gh:acme/repo:issue:2",
    type: "issue",
    title: "Fix bug",
    dateMs: Date.UTC(2026, 6, 20),
    repo: "acme/repo",
    number: 2,
    url: "https://github.com/acme/repo/issues/2",
    milestoneTitle: "v1.0",
    ...overrides,
  };
}

function release(overrides: Partial<GitHubItem> = {}): GitHubItem {
  return {
    id: "gh:acme/repo:release:v1.0.0",
    type: "release",
    title: "Version 1.0.0",
    dateMs: Date.UTC(2026, 6, 20),
    repo: "acme/repo",
    number: 0,
    url: "https://github.com/acme/repo/releases/tag/v1.0.0",
    ...overrides,
  };
}

describe("mapGitHubItems", () => {
  it("GitHubItemDTO[] を GitHubItem[] へ変換する(フィールドはそのまま)", () => {
    const dtos: GitHubItemDTO[] = [
      {
        id: "gh:acme/repo:milestone:1",
        type: "milestone",
        title: "v1.0",
        dateMs: 1_700_000_000_000,
        repo: "acme/repo",
        number: 1,
        url: "https://github.com/acme/repo/milestone/1",
      },
      {
        id: "gh:acme/repo:pr:3",
        type: "pr",
        title: "Add feature",
        dateMs: 1_700_000_000_000,
        repo: "acme/repo",
        number: 3,
        url: "https://github.com/acme/repo/pull/3",
        milestoneTitle: "v1.0",
      },
    ];
    expect(mapGitHubItems(dtos)).toEqual(dtos);
  });

  it("空配列を渡せば空配列を返す", () => {
    expect(mapGitHubItems([])).toEqual([]);
  });
});

describe("groupGitHubItemsByMilestone", () => {
  it("milestone とその issue/PR を1グループにまとめる", () => {
    const m = milestone();
    const c1 = child({ id: "gh:acme/repo:issue:2", number: 2 });
    const c2 = child({ id: "gh:acme/repo:pr:3", type: "pr", number: 3 });

    const groups = groupGitHubItemsByMilestone([m, c1, c2]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      key: "acme/repo::v1.0",
      repo: "acme/repo",
      milestoneTitle: "v1.0",
      milestone: m,
      children: [c1, c2],
    });
  });

  it("同じ repo でも milestoneTitle が違えば別グループになる", () => {
    const groups = groupGitHubItemsByMilestone([
      milestone({ title: "v1.0" }),
      milestone({ id: "gh:acme/repo:milestone:2", number: 2, title: "v2.0" }),
    ]);
    expect(groups.map((g) => g.milestoneTitle)).toEqual(["v1.0", "v2.0"]);
  });

  it("同名 milestone でも repo が違えば別グループになる", () => {
    const groups = groupGitHubItemsByMilestone([
      milestone({ repo: "acme/repo-a" }),
      milestone({ id: "gh:acme/repo-b:milestone:1", repo: "acme/repo-b" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.repo)).toEqual(["acme/repo-a", "acme/repo-b"]);
  });

  it("milestone 項目が無い issue/PR でも milestoneTitle だけでグループ化される(取りこぼし耐性)", () => {
    const c = child();
    const groups = groupGitHubItemsByMilestone([c]);
    expect(groups).toEqual([
      {
        key: "acme/repo::v1.0",
        repo: "acme/repo",
        milestoneTitle: "v1.0",
        milestone: null,
        children: [c],
      },
    ]);
  });

  it("milestoneTitle が無い issue/PR は「milestone なし」グループにまとめる", () => {
    const c = child({ milestoneTitle: undefined });
    const groups = groupGitHubItemsByMilestone([c]);
    expect(groups[0].milestoneTitle).toBe("(milestone なし)");
    expect(groups[0].children).toEqual([c]);
  });

  it("空配列を渡せば空配列を返す", () => {
    expect(groupGitHubItemsByMilestone([])).toEqual([]);
  });

  it("release アイテムは「milestone なし」グループにも他のグループにも入らない", () => {
    const r = release();
    const groups = groupGitHubItemsByMilestone([r]);
    expect(groups).toEqual([]);
  });

  it("release アイテムが混ざっていても milestone グループの結果に影響しない", () => {
    const m = milestone();
    const c = child();
    const r = release();
    const groups = groupGitHubItemsByMilestone([m, c, r]);
    expect(groups).toEqual([
      {
        key: "acme/repo::v1.0",
        repo: "acme/repo",
        milestoneTitle: "v1.0",
        milestone: m,
        children: [c],
      },
    ]);
  });
});

describe("layoutGitHubDay", () => {
  const dayStart = Date.UTC(2026, 6, 20);
  const dayEnd = Date.UTC(2026, 6, 21);

  it("日範囲外のアイテムは除外する", () => {
    const inRange = milestone({ dateMs: dayStart });
    const outOfRange = milestone({
      id: "gh:acme/repo:milestone:9",
      number: 9,
      dateMs: Date.UTC(2026, 6, 21),
    });
    const { visibleGroups } = layoutGitHubDay([inRange, outOfRange], dayStart, dayEnd);
    expect(visibleGroups.map((g) => g.milestone?.id)).toEqual([inRange.id]);
  });

  it("上限以下なら全グループを表示し overflowCount は 0", () => {
    const groupsInput = [milestone(), child()];
    const { visibleGroups, overflowCount } = layoutGitHubDay(groupsInput, dayStart, dayEnd, 3);
    expect(visibleGroups).toHaveLength(1);
    expect(overflowCount).toBe(0);
  });

  it("上限を超えた分は overflowCount にまとめ、超過グループごと非表示にする", () => {
    const items = [
      milestone({ id: "gh:acme/repo:milestone:1", number: 1, title: "v1.0" }),
      child({ id: "gh:acme/repo:issue:2", number: 2, milestoneTitle: "v1.0" }),
      milestone({ id: "gh:acme/repo:milestone:2", number: 2, title: "v2.0" }),
      milestone({ id: "gh:acme/repo:milestone:3", number: 3, title: "v3.0" }),
      // v4.0 は milestone 見出し無しで issue 2件のみ(超過グループが複数項目でも
      // overflowCount がまとめて数えられることを確認する)
      child({ id: "gh:acme/repo:issue:10", number: 10, milestoneTitle: "v4.0" }),
      child({ id: "gh:acme/repo:issue:11", number: 11, milestoneTitle: "v4.0" }),
    ];

    const { visibleGroups, overflowCount } = layoutGitHubDay(items, dayStart, dayEnd, 2);

    expect(visibleGroups.map((g) => g.milestoneTitle)).toEqual(["v1.0", "v2.0"]);
    // 非表示: v3.0 (milestone 見出し1件) + v4.0 (issue 2件) = 3件
    expect(overflowCount).toBe(3);
  });

  it("既定の上限は GITHUB_MAX_VISIBLE_MILESTONES", () => {
    const items = Array.from({ length: GITHUB_MAX_VISIBLE_MILESTONES + 2 }, (_, i) =>
      milestone({ id: `gh:acme/repo:milestone:${i}`, number: i, title: `v${i}` }),
    );
    const { visibleGroups, overflowCount } = layoutGitHubDay(items, dayStart, dayEnd);
    expect(visibleGroups).toHaveLength(GITHUB_MAX_VISIBLE_MILESTONES);
    expect(overflowCount).toBe(2);
  });

  it("空配列を渡せば空の結果を返す", () => {
    expect(layoutGitHubDay([], dayStart, dayEnd)).toEqual({
      visibleGroups: [],
      releases: [],
      overflowCount: 0,
    });
  });

  it("日範囲内の release は releases に入る", () => {
    const r = release({ dateMs: dayStart });
    const { releases } = layoutGitHubDay([r], dayStart, dayEnd);
    expect(releases).toEqual([r]);
  });

  it("日範囲外の release は除外する", () => {
    const outOfRange = release({ dateMs: Date.UTC(2026, 6, 21) });
    const { releases } = layoutGitHubDay([outOfRange], dayStart, dayEnd);
    expect(releases).toEqual([]);
  });

  it("release は overflowCount や maxVisibleGroups の対象にならない", () => {
    const releases = Array.from({ length: 10 }, (_, i) =>
      release({ id: `gh:acme/repo:release:v${i}.0.0`, dateMs: dayStart }),
    );
    const result = layoutGitHubDay(releases, dayStart, dayEnd, 3);
    expect(result.releases).toHaveLength(10);
    expect(result.overflowCount).toBe(0);
  });

  it("release と milestone グループは同じ日の結果に共存する", () => {
    const m = milestone({ dateMs: dayStart });
    const c = child({ dateMs: dayStart });
    const r = release({ dateMs: dayStart });
    const { visibleGroups, releases } = layoutGitHubDay([m, c, r], dayStart, dayEnd);
    expect(visibleGroups).toHaveLength(1);
    expect(releases).toEqual([r]);
  });
});
