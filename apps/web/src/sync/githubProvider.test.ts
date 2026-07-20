import { describe, expect, it } from "vite-plus/test";
import {
  mapGhSearchToWorkItems,
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
