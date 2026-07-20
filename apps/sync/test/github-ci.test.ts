import { describe, expect, it, vi } from "vite-plus/test";
import { fetchGitHubCiRuns } from "../src/core/github-ci";

/** URL パターンにマッチさせて JSON レスポンスを返す fetch モック (github-activity.test.ts の
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

function rawRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  createdAt: string,
) {
  return {
    id,
    name,
    html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
    status,
    conclusion,
    created_at: createdAt,
  };
}

const SINCE_ISO = "2026-07-01T00:00:00Z";
const UNTIL_ISO = "2026-07-31T00:00:00Z";

describe("fetchGitHubCiRuns", () => {
  it("flattens installations -> repos -> workflow runs into DTOs", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/actions\/runs/,
        response: () =>
          jsonResponse({
            total_count: 1,
            workflow_runs: [rawRun(1, "CI", "completed", "success", "2026-07-15T10:00:00Z")],
          }),
      },
    ]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

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

  it("passes the since/until range through as a created= filter on the runs request", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([{ owner: "acme", name: "widgets" }]),
      {
        match: /\/repos\/acme\/widgets\/actions\/runs/,
        response: () => jsonResponse({ total_count: 0, workflow_runs: [] }),
      },
    ]);

    await fetchGitHubCiRuns({ fetch: fetchImpl, token: "token-abc" }, SINCE_ISO, UNTIL_ISO);

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [
      string | URL | Request,
      unknown,
    ][];
    const calledUrl = calls
      .map(([input]) => (typeof input === "string" ? input : String(input)))
      .find((u) => u.includes("/repos/acme/widgets/actions/runs"));
    expect(calledUrl).toBeDefined();
    const parsed = new URL(calledUrl as string);
    expect(parsed.searchParams.get("created")).toBe(`${SINCE_ISO}..${UNTIL_ISO}`);
  });

  it("flattens runs across multiple repos", async () => {
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "widgets" },
        { owner: "acme", name: "gadgets" },
      ]),
      {
        match: /\/repos\/acme\/widgets\/actions\/runs/,
        response: () =>
          jsonResponse({
            total_count: 1,
            workflow_runs: [rawRun(1, "CI", "completed", "success", "2026-07-15T10:00:00Z")],
          }),
      },
      {
        match: /\/repos\/acme\/gadgets\/actions\/runs/,
        response: () =>
          jsonResponse({
            total_count: 1,
            workflow_runs: [rawRun(2, "CI", "in_progress", null, "2026-07-16T10:00:00Z")],
          }),
      },
    ]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

    expect(items.map((i) => i.id)).toEqual(["gci:acme/widgets:1", "gci:acme/gadgets:2"]);
  });

  it("continues past a repo whose workflow runs fetch fails, logging the error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "broken" },
        { owner: "acme", name: "widgets" },
      ]),
      {
        match: /\/repos\/acme\/broken\/actions\/runs/,
        response: () => new Response("server error", { status: 500 }),
      },
      {
        match: /\/repos\/acme\/widgets\/actions\/runs/,
        response: () =>
          jsonResponse({
            total_count: 1,
            workflow_runs: [rawRun(1, "CI", "completed", "success", "2026-07-15T10:00:00Z")],
          }),
      },
    ]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

    expect(items).toHaveLength(1);
    expect(items[0].repo).toBe("acme/widgets");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("treats a repo returning 404 (via listWorkflowRuns) as no runs, without logging an error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute([
        { owner: "acme", name: "no-actions" },
        { owner: "acme", name: "widgets" },
      ]),
      {
        match: /\/repos\/acme\/no-actions\/actions\/runs/,
        response: () => new Response("Not Found", { status: 404 }),
      },
      {
        match: /\/repos\/acme\/widgets\/actions\/runs/,
        response: () =>
          jsonResponse({
            total_count: 1,
            workflow_runs: [rawRun(1, "CI", "completed", "success", "2026-07-15T10:00:00Z")],
          }),
      },
    ]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

    expect(items).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns an empty array when there are no installed repos", async () => {
    const fetchImpl = routedFetch([INSTALLATIONS_ROUTE, reposRoute([])]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

    expect(items).toEqual([]);
  });

  it("stops once the total run safety cap is reached, warning once", async () => {
    // 1 repo あたりの上限 (github/workflow-runs.ts の MAX_RUNS_PER_REPO=200) ちょうどに収まる
    // 件数を複数 repo に配って、repo をまたいだ合計だけが上限 (1000) を超える状況を作る
    // (200 は per-repo 上限を超えないので listWorkflowRuns 側の warn は出ない)。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runsFor = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) =>
        rawRun(
          Number(`${prefix.charCodeAt(0)}${i}`),
          "CI",
          "completed",
          "success",
          "2026-07-15T10:00:00Z",
        ),
      );
    const repoNames = ["r1", "r2", "r3", "r4", "r5", "r6"];

    const fetchImpl = routedFetch([
      INSTALLATIONS_ROUTE,
      reposRoute(repoNames.map((name) => ({ owner: "acme", name }))),
      ...repoNames.map((name) => ({
        match: new RegExp(`/repos/acme/${name}/actions/runs`),
        response: () => jsonResponse({ total_count: 200, workflow_runs: runsFor(name) }),
      })),
    ]);

    const items = await fetchGitHubCiRuns(
      { fetch: fetchImpl, token: "token-abc" },
      SINCE_ISO,
      UNTIL_ISO,
    );

    expect(items).toHaveLength(1000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
