import { describe, expect, it, vi } from "vite-plus/test";
import { fetchGitHubItems } from "../src/core/github-items";

/** URL パターンにマッチさせて JSON レスポンスを返す fetch モック。 */
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

const INSTALLATIONS_ROUTE = {
  match: /\/user\/installations(\?|$)/,
  response: () => jsonResponse({ total_count: 1, installations: [{ id: 1 }] }),
};

function reposRoute(repos: { owner: string; name: string }[]) {
  return {
    match: /\/user\/installations\/1\/repositories/,
    response: () =>
      jsonResponse({
        total_count: repos.length,
        repositories: repos.map((r) => ({ name: r.name, owner: { login: r.owner } })),
      }),
  };
}

describe("fetchGitHubItems", () => {
  it("flattens installations -> repos -> milestones -> issues/PRs into DTOs", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "v1.0",
              due_on: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/widgets/milestone/1",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/issues\?milestone=1/,
        response: () =>
          jsonResponse([
            {
              number: 10,
              title: "Fix crash",
              html_url: "https://github.com/acme/widgets/issues/10",
            },
            {
              number: 11,
              title: "Add feature",
              html_url: "https://github.com/acme/widgets/pull/11",
              pull_request: { url: "..." },
            },
          ]),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    const dueMs = Date.parse("2026-08-01T00:00:00Z");
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

  it("excludes milestones without due_on and does not fetch issues for them", async () => {
    const issuesRoute = {
      match: /\/repos\/acme\/widgets\/issues/,
      response: vi.fn(() => jsonResponse([])),
    };
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            { number: 1, title: "no due date", due_on: null, html_url: "https://x/1" },
          ]),
      },
      issuesRoute,
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([]);
    expect(issuesRoute.response).not.toHaveBeenCalled();
  });

  it("continues past a repo whose milestone fetch fails, logging the error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "broken" },
        { owner: "acme", name: "widgets" },
      ]),
      {
        match: /\/repos\/acme\/broken\/milestones/,
        response: () => new Response("server error", { status: 500 }),
      },
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "v1.0",
              due_on: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/widgets/milestone/1",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/issues/,
        response: () => jsonResponse([]),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toHaveLength(1);
    expect(items[0].repo).toBe("acme/widgets");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("continues past a milestone whose issue fetch fails, still including the milestone itself", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "v1.0",
              due_on: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/widgets/milestone/1",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/issues/,
        response: () => new Response("server error", { status: 500 }),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([
      {
        id: "gh:acme/widgets:milestone:1",
        type: "milestone",
        title: "v1.0",
        dateMs: Date.parse("2026-08-01T00:00:00Z"),
        repo: "acme/widgets",
        number: 1,
        url: "https://github.com/acme/widgets/milestone/1",
      },
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns an empty array when there are no installed repos", async () => {
    const fetchImpl = routedFetch([INSTALLATIONS_ROUTE, reposRoute([])]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([]);
  });

  it("includes published releases as flattened items", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () => jsonResponse([]),
      },
      {
        match: /\/repos\/acme\/widgets\/releases/,
        response: () =>
          jsonResponse([
            {
              tag_name: "v1.0.0",
              name: "Version 1.0.0",
              html_url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
              published_at: "2026-08-01T00:00:00Z",
              draft: false,
              prerelease: false,
            },
          ]),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([
      {
        id: "gh:acme/widgets:release:v1.0.0",
        type: "release",
        title: "Version 1.0.0",
        dateMs: Date.parse("2026-08-01T00:00:00Z"),
        repo: "acme/widgets",
        number: 0,
        url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
      },
    ]);
  });

  it("continues past a repo whose release fetch fails, keeping that repo's milestones/issues and other repos", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "widgets" },
        { owner: "acme", name: "other" },
      ]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "v1.0",
              due_on: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/widgets/milestone/1",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/issues/,
        response: () =>
          jsonResponse([
            {
              number: 10,
              title: "Fix crash",
              html_url: "https://github.com/acme/widgets/issues/10",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/releases/,
        response: () => new Response("server error", { status: 500 }),
      },
      {
        match: /\/repos\/acme\/other\/milestones/,
        response: () => jsonResponse([]),
      },
      {
        match: /\/repos\/acme\/other\/releases/,
        response: () =>
          jsonResponse([
            {
              tag_name: "v9.0.0",
              name: "Version 9.0.0",
              html_url: "https://github.com/acme/other/releases/tag/v9.0.0",
              published_at: "2026-08-02T00:00:00Z",
              draft: false,
              prerelease: false,
            },
          ]),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items).toEqual([
      {
        id: "gh:acme/widgets:milestone:1",
        type: "milestone",
        title: "v1.0",
        dateMs: Date.parse("2026-08-01T00:00:00Z"),
        repo: "acme/widgets",
        number: 1,
        url: "https://github.com/acme/widgets/milestone/1",
      },
      {
        id: "gh:acme/widgets:issue:10",
        type: "issue",
        title: "Fix crash",
        dateMs: Date.parse("2026-08-01T00:00:00Z"),
        repo: "acme/widgets",
        number: 10,
        url: "https://github.com/acme/widgets/issues/10",
        milestoneTitle: "v1.0",
      },
      {
        id: "gh:acme/other:release:v9.0.0",
        type: "release",
        title: "Version 9.0.0",
        dateMs: Date.parse("2026-08-02T00:00:00Z"),
        repo: "acme/other",
        number: 0,
        url: "https://github.com/acme/other/releases/tag/v9.0.0",
      },
    ]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns milestones/issues/PRs and releases together for the same repo", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/milestones/,
        response: () =>
          jsonResponse([
            {
              number: 1,
              title: "v1.0",
              due_on: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/widgets/milestone/1",
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/issues\?milestone=1/,
        response: () =>
          jsonResponse([
            {
              number: 11,
              title: "Add feature",
              html_url: "https://github.com/acme/widgets/pull/11",
              pull_request: { url: "..." },
            },
          ]),
      },
      {
        match: /\/repos\/acme\/widgets\/releases/,
        response: () =>
          jsonResponse([
            {
              tag_name: "v1.0.0",
              name: "Version 1.0.0",
              html_url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
              published_at: "2026-07-15T00:00:00Z",
              draft: false,
              prerelease: false,
            },
          ]),
      },
    ]);

    const items = await fetchGitHubItems({ fetch: fetchImpl, token: "token-abc" });

    expect(items.map((it) => it.type).sort()).toEqual(["milestone", "pr", "release"]);
    expect(items.map((it) => it.id)).toEqual([
      "gh:acme/widgets:milestone:1",
      "gh:acme/widgets:pr:11",
      "gh:acme/widgets:release:v1.0.0",
    ]);
  });
});
