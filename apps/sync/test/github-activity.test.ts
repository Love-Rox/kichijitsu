import { describe, expect, it, vi } from "vite-plus/test";
import { fetchGitHubActivity } from "../src/core/github-activity";

/** URL パターンにマッチさせて JSON レスポンスを返す fetch モック (github-items.test.ts の
 * routedFetch と同じ考え方)。 */
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

function rawCommit(sha: string, message: string, timestamp: string) {
  return {
    sha,
    html_url: `https://github.com/acme/widgets/commit/${sha}`,
    commit: { message, author: { date: timestamp } },
  };
}

const BASE_DEPS = {
  login: "octocat",
  sinceIso: "2026-07-01T00:00:00Z",
  untilIso: "2026-07-31T00:00:00Z",
};

describe("fetchGitHubActivity", () => {
  it("flattens installations -> repos -> commits into DTOs", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/commits/,
        response: () => jsonResponse([rawCommit("sha1", "Fix crash", "2026-07-15T10:00:00Z")]),
      },
    ]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

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

  it("passes author/since/until through to the commits request", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      { match: /\/repos\/acme\/widgets\/commits/, response: () => jsonResponse([]) },
    ]);

    await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [
      string | URL | Request,
      unknown,
    ][];
    const calledUrl = calls
      .map(([input]) => (typeof input === "string" ? input : String(input)))
      .find((u) => u.includes("/repos/acme/widgets/commits"));
    expect(calledUrl).toBeDefined();
    const parsed = new URL(calledUrl as string);
    expect(parsed.searchParams.get("author")).toBe("octocat");
    expect(parsed.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(parsed.searchParams.get("until")).toBe("2026-07-31T00:00:00Z");
  });

  it("flattens commits across multiple repos", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "widgets" },
        { owner: "acme", name: "gadgets" },
      ]),
      {
        match: /\/repos\/acme\/widgets\/commits/,
        response: () => jsonResponse([rawCommit("sha1", "Fix widgets", "2026-07-15T10:00:00Z")]),
      },
      {
        match: /\/repos\/acme\/gadgets\/commits/,
        response: () => jsonResponse([rawCommit("sha2", "Fix gadgets", "2026-07-16T10:00:00Z")]),
      },
    ]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    expect(items.map((i) => i.id)).toEqual([
      "gha:acme/widgets:commit:sha1",
      "gha:acme/gadgets:commit:sha2",
    ]);
  });

  it("continues past a repo whose commit fetch fails, logging the error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "broken" },
        { owner: "acme", name: "widgets" },
      ]),
      {
        match: /\/repos\/acme\/broken\/commits/,
        response: () => new Response("server error", { status: 500 }),
      },
      {
        match: /\/repos\/acme\/widgets\/commits/,
        response: () => jsonResponse([rawCommit("sha1", "Fix crash", "2026-07-15T10:00:00Z")]),
      },
    ]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    expect(items).toHaveLength(1);
    expect(items[0].repo).toBe("acme/widgets");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("treats a repo returning 404/409 (via listCommits) as no activity, without logging an error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "empty" },
        { owner: "acme", name: "widgets" },
      ]),
      {
        match: /\/repos\/acme\/empty\/commits/,
        response: () => new Response("Git Repository is empty.", { status: 409 }),
      },
      {
        match: /\/repos\/acme\/widgets\/commits/,
        response: () => jsonResponse([rawCommit("sha1", "Fix crash", "2026-07-15T10:00:00Z")]),
      },
    ]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    expect(items).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns an empty array when there are no installed repos", async () => {
    const fetchImpl = routedFetch([INSTALLATIONS_ROUTE, reposRoute([])]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    expect(items).toEqual([]);
  });

  it("stops once the total activity safety cap is reached, warning once", async () => {
    // 1 repo あたりの上限 (github/commits.ts の MAX_COMMITS_PER_REPO=300) ちょうどに収まる
    // 件数を複数 repo に配って、repo をまたいだ合計だけが上限 (1000) を超える状況を作る
    // (300 は per-repo 上限を超えないので listCommits 側の warn は出ない)。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const commitsFor = (prefix: string) =>
      Array.from({ length: 300 }, (_, i) =>
        rawCommit(`${prefix}-${i}`, "msg", "2026-07-15T10:00:00Z"),
      );
    const repoNames = ["r1", "r2", "r3", "r4"];

    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute(repoNames.map((name) => ({ owner: "acme", name }))),
      ...repoNames.map((name) => ({
        match: new RegExp(`/repos/acme/${name}/commits`),
        response: () => jsonResponse(commitsFor(name)),
      })),
    ]);

    const items = await fetchGitHubActivity({ fetch: fetchImpl, token: "token-abc", ...BASE_DEPS });

    expect(items).toHaveLength(1000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
