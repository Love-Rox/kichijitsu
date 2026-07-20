import { describe, expect, it, vi } from "vite-plus/test";
import { fetchGitHubQueue } from "../src/core/github-queue";

/** クエリ文字列にマッチさせて JSON レスポンスを返す fetch モック (github-items.test.ts の
 * routedFetch と同じ考え方、ここでは URL の `q=` パラメータで振り分ける)。 */
function routedFetch(routes: { match: RegExp; response: () => Response }[]): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const route of routes) {
      if (route.match.test(url)) return route.response();
    }
    throw new Error(`unmocked URL: ${url}`);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function searchResponse(items: unknown[]) {
  return () => jsonResponse({ total_count: items.length, items });
}

const REVIEW_REQUESTED = /review-requested/;
const ASSIGNED = /assignee/;
const AUTHORED = /author/;

describe("fetchGitHubQueue", () => {
  it("flattens the 3 queries into DTOs tagged with their kind", async () => {
    const fetchImpl = routedFetch([
      {
        match: REVIEW_REQUESTED,
        response: searchResponse([
          {
            number: 1,
            title: "Review this PR",
            html_url: "https://github.com/acme/widgets/pull/1",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-01T00:00:00Z",
            pull_request: { url: "..." },
          },
        ]),
      },
      {
        match: ASSIGNED,
        response: searchResponse([
          {
            number: 2,
            title: "Fix this issue",
            html_url: "https://github.com/acme/widgets/issues/2",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-02T00:00:00Z",
          },
        ]),
      },
      {
        match: AUTHORED,
        response: searchResponse([
          {
            number: 3,
            title: "My own PR",
            html_url: "https://github.com/acme/widgets/pull/3",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-03T00:00:00Z",
            pull_request: { url: "..." },
          },
        ]),
      },
    ]);

    const items = await fetchGitHubQueue({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([
      {
        id: "ghq:acme/widgets:pr:1",
        type: "pr",
        kinds: ["review_requested"],
        title: "Review this PR",
        repo: "acme/widgets",
        number: 1,
        url: "https://github.com/acme/widgets/pull/1",
        updatedAt: "2026-07-01T00:00:00Z",
      },
      {
        id: "ghq:acme/widgets:issue:2",
        type: "issue",
        kinds: ["assigned"],
        title: "Fix this issue",
        repo: "acme/widgets",
        number: 2,
        url: "https://github.com/acme/widgets/issues/2",
        updatedAt: "2026-07-02T00:00:00Z",
      },
      {
        id: "ghq:acme/widgets:pr:3",
        type: "pr",
        kinds: ["authored"],
        title: "My own PR",
        repo: "acme/widgets",
        number: 3,
        url: "https://github.com/acme/widgets/pull/3",
        updatedAt: "2026-07-03T00:00:00Z",
      },
    ]);
  });

  it("merges kinds for the same (repo, number) hit by multiple queries instead of duplicating", async () => {
    const samePr = {
      number: 9,
      title: "My PR that I'm also assigned to review on",
      html_url: "https://github.com/acme/widgets/pull/9",
      repository_url: "https://api.github.com/repos/acme/widgets",
      updated_at: "2026-07-05T00:00:00Z",
      pull_request: { url: "..." },
    };
    const fetchImpl = routedFetch([
      { match: REVIEW_REQUESTED, response: searchResponse([samePr]) },
      { match: ASSIGNED, response: searchResponse([]) },
      { match: AUTHORED, response: searchResponse([samePr]) },
    ]);

    const items = await fetchGitHubQueue({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ghq:acme/widgets:pr:9");
    expect(items[0].kinds.sort()).toEqual(["authored", "review_requested"]);
  });

  it("continues past a failing query, logging the error, and still returns the others", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      { match: REVIEW_REQUESTED, response: () => new Response("server error", { status: 500 }) },
      {
        match: ASSIGNED,
        response: searchResponse([
          {
            number: 2,
            title: "Fix this issue",
            html_url: "https://github.com/acme/widgets/issues/2",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-02T00:00:00Z",
          },
        ]),
      },
      { match: AUTHORED, response: searchResponse([]) },
    ]);

    const items = await fetchGitHubQueue({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ghq:acme/widgets:issue:2");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns an empty array when all 3 queries have no results", async () => {
    const fetchImpl = routedFetch([
      { match: REVIEW_REQUESTED, response: searchResponse([]) },
      { match: ASSIGNED, response: searchResponse([]) },
      { match: AUTHORED, response: searchResponse([]) },
    ]);

    const items = await fetchGitHubQueue({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([]);
  });
});
