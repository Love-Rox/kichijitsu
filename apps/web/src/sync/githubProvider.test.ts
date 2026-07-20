import { describe, expect, it } from "vite-plus/test";
import {
  mapGhCommitsToActivity,
  mapGhPullCommitsToTimestamps,
  mapGhRepoItemsToDTO,
  mapGhSearchToWorkItems,
  mapGhWorkflowRunsToCi,
  type GhRawCommit,
  type GhRawIssue,
  type GhRawMilestone,
  type GhRawPullCommit,
  type GhRawRelease,
  type GhRawWorkflowRun,
  type GhSearchItem,
  type GhWorkQueryResult,
} from "./githubProvider";

function ghItem(overrides: Partial<GhSearchItem> = {}): GhSearchItem {
  return {
    number: 1,
    title: "Fix bug",
    html_url: "https://github.com/acme/repo/issues/1",
    repository_url: "https://api.github.com/repos/acme/repo",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("mapGhSearchToWorkItems", () => {
  it("issue を review/assigned/authored の kind とともに DTO に map する", () => {
    const items = mapGhSearchToWorkItems([{ kind: "assigned", body: { items: [ghItem()] } }]);
    expect(items).toEqual([
      {
        id: "ghq:acme/repo:issue:1",
        type: "issue",
        kinds: ["assigned"],
        title: "Fix bug",
        repo: "acme/repo",
        number: 1,
        url: "https://github.com/acme/repo/issues/1",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("pull_request フィールドの有無で type=pr を判定し id に反映する", () => {
    const items = mapGhSearchToWorkItems([
      {
        kind: "authored",
        body: {
          items: [
            ghItem({
              number: 42,
              pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/42" },
              html_url: "https://github.com/acme/repo/pull/42",
            }),
          ],
        },
      },
    ]);
    expect(items[0].type).toBe("pr");
    expect(items[0].id).toBe("ghq:acme/repo:pr:42");
  });

  it("同一 (repo, number, type) が複数クエリにヒットしても1件にまとめ kinds をマージする", () => {
    const pr = ghItem({
      number: 7,
      pull_request: {},
      html_url: "https://github.com/acme/repo/pull/7",
    });
    const results: GhWorkQueryResult[] = [
      { kind: "review_requested", body: { items: [pr] } },
      { kind: "authored", body: { items: [pr] } },
    ];
    const items = mapGhSearchToWorkItems(results);
    expect(items).toHaveLength(1);
    expect(items[0].kinds).toEqual(["review_requested", "authored"]);
  });

  it("同じ kind で重複ヒットしても kinds に重複を入れない", () => {
    const pr = ghItem({ number: 7, pull_request: {} });
    const items = mapGhSearchToWorkItems([{ kind: "authored", body: { items: [pr, pr] } }]);
    expect(items[0].kinds).toEqual(["authored"]);
  });

  it("issue と PR は同じ number でも別アイテム (type が id に入る) として扱う", () => {
    const items = mapGhSearchToWorkItems([
      { kind: "assigned", body: { items: [ghItem({ number: 5 })] } },
      { kind: "authored", body: { items: [ghItem({ number: 5, pull_request: {} })] } },
    ]);
    expect(items.map((i) => i.id)).toEqual(["ghq:acme/repo:issue:5", "ghq:acme/repo:pr:5"]);
  });

  it("repository_url が壊れている item はスキップする", () => {
    const items = mapGhSearchToWorkItems([
      {
        kind: "assigned",
        body: {
          items: [
            ghItem({ repository_url: "https://api.github.com/broken" }),
            ghItem({ number: 2 }),
          ],
        },
      },
    ]);
    expect(items.map((i) => i.number)).toEqual([2]);
  });

  it("items が無い body (空/未定義) は無視する", () => {
    expect(mapGhSearchToWorkItems([{ kind: "assigned", body: {} }])).toEqual([]);
    expect(mapGhSearchToWorkItems([{ kind: "assigned", body: { items: [] } }])).toEqual([]);
    expect(mapGhSearchToWorkItems([])).toEqual([]);
  });
});

function ghMilestone(overrides: Partial<GhRawMilestone> = {}): GhRawMilestone {
  return {
    number: 1,
    title: "v1.0",
    due_on: "2026-08-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/milestone/1",
    ...overrides,
  };
}

function ghIssue(overrides: Partial<GhRawIssue> = {}): GhRawIssue {
  return {
    number: 10,
    title: "Fix crash",
    html_url: "https://github.com/acme/widgets/issues/10",
    ...overrides,
  };
}

function ghRelease(overrides: Partial<GhRawRelease> = {}): GhRawRelease {
  return {
    tag_name: "v1.0.0",
    name: "Version 1.0.0",
    html_url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
    published_at: "2026-08-01T00:00:00Z",
    draft: false,
    ...overrides,
  };
}

describe("mapGhRepoItemsToDTO", () => {
  it("milestone + issue/PR + release を DTO に flatten し、milestoneTitle・due_on を継承する", () => {
    const dueMs = Date.parse("2026-08-01T00:00:00Z");
    const items = mapGhRepoItemsToDTO(
      "acme/widgets",
      [ghMilestone()],
      {
        1: [
          ghIssue({ number: 10, title: "Fix crash" }),
          ghIssue({
            number: 11,
            title: "Add feature",
            html_url: "https://github.com/acme/widgets/pull/11",
            pull_request: { url: "..." },
          }),
        ],
      },
      [],
    );

    expect(items).toEqual([
      {
        id: "gh:acme/widgets:milestone:1",
        type: "milestone",
        title: "v1.0",
        dateMs: dueMs,
        repo: "acme/widgets",
        number: 1,
        url: "https://github.com/acme/widgets/milestone/1",
      },
      {
        id: "gh:acme/widgets:issue:10",
        type: "issue",
        title: "Fix crash",
        dateMs: dueMs,
        repo: "acme/widgets",
        number: 10,
        url: "https://github.com/acme/widgets/issues/10",
        milestoneTitle: "v1.0",
      },
      {
        id: "gh:acme/widgets:pr:11",
        type: "pr",
        title: "Add feature",
        dateMs: dueMs,
        repo: "acme/widgets",
        number: 11,
        url: "https://github.com/acme/widgets/pull/11",
        milestoneTitle: "v1.0",
      },
    ]);
  });

  it("due_on が無い milestone は除外し、issuesByMilestone にデータがあっても使わない", () => {
    const items = mapGhRepoItemsToDTO(
      "acme/widgets",
      [ghMilestone({ due_on: null })],
      { 1: [ghIssue()] },
      [],
    );
    expect(items).toEqual([]);
  });

  it("draft の release と published_at の無い release を除外する", () => {
    const items = mapGhRepoItemsToDTO("acme/widgets", [], {}, [
      ghRelease({ tag_name: "v-draft", draft: true }),
      ghRelease({ tag_name: "v-unpublished", published_at: null }),
    ]);
    expect(items).toEqual([]);
  });

  it("release の title は name が空/null なら tag_name にフォールバックする", () => {
    const items = mapGhRepoItemsToDTO("acme/widgets", [], {}, [
      ghRelease({ tag_name: "v1.0.0", name: "Version 1.0.0" }),
      ghRelease({ tag_name: "v2.0.0", name: null }),
      ghRelease({ tag_name: "v3.0.0", name: "" }),
    ]);
    expect(items.map((i) => i.title)).toEqual(["Version 1.0.0", "v2.0.0", "v3.0.0"]);
  });

  it("release の id は number=0 で tagName を含む", () => {
    const items = mapGhRepoItemsToDTO("acme/widgets", [], {}, [ghRelease({ tag_name: "v1.0.0" })]);
    expect(items[0]).toMatchObject({
      id: "gh:acme/widgets:release:v1.0.0",
      type: "release",
      number: 0,
    });
  });
});

describe("mapGhCommitsToActivity", () => {
  function ghCommit(overrides: Partial<GhRawCommit> = {}): GhRawCommit {
    return {
      sha: "sha1",
      html_url: "https://github.com/acme/widgets/commit/sha1",
      commit: { message: "Fix crash", author: { date: "2026-07-15T10:00:00Z" } },
      ...overrides,
    };
  }

  it("commit を DTO に map し、message は先頭行のみ採用する", () => {
    const items = mapGhCommitsToActivity("acme/widgets", [
      ghCommit({
        commit: { message: "Fix crash\n\nDetails here", author: { date: "2026-07-15T10:00:00Z" } },
      }),
    ]);
    expect(items).toEqual([
      {
        id: "gha:acme/widgets:commit:sha1",
        type: "commit",
        title: "Fix crash",
        repo: "acme/widgets",
        url: "https://github.com/acme/widgets/commit/sha1",
        timestampMs: Date.parse("2026-07-15T10:00:00Z"),
      },
    ]);
  });

  it("commit.author.date が無ければ commit.committer.date を使う", () => {
    const items = mapGhCommitsToActivity("acme/widgets", [
      ghCommit({
        commit: { message: "Fix crash", committer: { date: "2026-07-16T10:00:00Z" } },
      }),
    ]);
    expect(items[0].timestampMs).toBe(Date.parse("2026-07-16T10:00:00Z"));
  });

  it("複数 commit を順序通りに map する", () => {
    const items = mapGhCommitsToActivity("acme/widgets", [
      ghCommit({ sha: "sha1" }),
      ghCommit({ sha: "sha2" }),
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "gha:acme/widgets:commit:sha1",
      "gha:acme/widgets:commit:sha2",
    ]);
  });
});

describe("mapGhWorkflowRunsToCi", () => {
  function ghRun(overrides: Partial<GhRawWorkflowRun> = {}): GhRawWorkflowRun {
    return {
      id: 1,
      name: "CI",
      html_url: "https://github.com/acme/widgets/actions/runs/1",
      status: "completed",
      conclusion: "success",
      created_at: "2026-07-15T10:00:00Z",
      ...overrides,
    };
  }

  it("workflow run を DTO に map する", () => {
    const items = mapGhWorkflowRunsToCi("acme/widgets", [ghRun()]);
    expect(items).toEqual([
      {
        id: "gci:acme/widgets:1",
        repo: "acme/widgets",
        name: "CI",
        url: "https://github.com/acme/widgets/actions/runs/1",
        status: "completed",
        conclusion: "success",
        timestampMs: Date.parse("2026-07-15T10:00:00Z"),
      },
    ]);
  });

  it("name が null なら空文字にフォールバックする", () => {
    const items = mapGhWorkflowRunsToCi("acme/widgets", [ghRun({ name: null })]);
    expect(items[0].name).toBe("");
  });

  it("未完了 (conclusion=null) の run もそのまま渡す", () => {
    const items = mapGhWorkflowRunsToCi("acme/widgets", [
      ghRun({ status: "in_progress", conclusion: null }),
    ]);
    expect(items[0].status).toBe("in_progress");
    expect(items[0].conclusion).toBeNull();
  });
});

describe("mapGhPullCommitsToTimestamps", () => {
  function ghPullCommit(overrides: Partial<GhRawPullCommit> = {}): GhRawPullCommit {
    return {
      sha: "sha1",
      commit: { author: { date: "2026-07-15T10:00:00Z" } },
      author: { login: "octocat" },
      ...overrides,
    };
  }

  it("author.login が一致する commit だけを残す", () => {
    const timestamps = mapGhPullCommitsToTimestamps(
      [
        ghPullCommit({ author: { login: "octocat" } }),
        ghPullCommit({ author: { login: "someone-else" } }),
      ],
      "octocat",
    );
    expect(timestamps).toEqual(["2026-07-15T10:00:00Z"]);
  });

  it("author が null の commit を除外する", () => {
    const timestamps = mapGhPullCommitsToTimestamps([ghPullCommit({ author: null })], "octocat");
    expect(timestamps).toEqual([]);
  });

  it("commit.author.date が無ければ commit.committer.date を使う", () => {
    const timestamps = mapGhPullCommitsToTimestamps(
      [ghPullCommit({ commit: { committer: { date: "2026-07-16T10:00:00Z" } } })],
      "octocat",
    );
    expect(timestamps).toEqual(["2026-07-16T10:00:00Z"]);
  });

  it("author.date も committer.date も無い commit はスキップする", () => {
    const timestamps = mapGhPullCommitsToTimestamps([ghPullCommit({ commit: {} })], "octocat");
    expect(timestamps).toEqual([]);
  });

  it("昇順にソートして返す", () => {
    const timestamps = mapGhPullCommitsToTimestamps(
      [
        ghPullCommit({ sha: "sha2", commit: { author: { date: "2026-07-20T00:00:00Z" } } }),
        ghPullCommit({ sha: "sha1", commit: { author: { date: "2026-07-10T00:00:00Z" } } }),
      ],
      "octocat",
    );
    expect(timestamps).toEqual(["2026-07-10T00:00:00Z", "2026-07-20T00:00:00Z"]);
  });
});
