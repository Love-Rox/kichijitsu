import { describe, expect, it, vi } from "vite-plus/test";
import { fetchPullCommitsForItems } from "../src/core/github-pr-commits";

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

function rawPullCommit(sha: string, timestamp: string, login = "octocat") {
  return {
    sha,
    commit: { author: { date: timestamp } },
    author: { login },
  };
}

const BASE_DEPS = { token: "token-abc", login: "octocat" };

describe("fetchPullCommitsForItems", () => {
  it("combines multiple PR items into one Record keyed by repo#number", async () => {
    const fetchImpl = routedFetch([
      {
        match: /\/repos\/acme\/widgets\/pulls\/42\/commits/,
        response: () => jsonResponse([rawPullCommit("sha1", "2026-07-15T10:00:00Z")]),
      },
      {
        match: /\/repos\/acme\/gadgets\/pulls\/7\/commits/,
        response: () => jsonResponse([rawPullCommit("sha2", "2026-07-16T10:00:00Z")]),
      },
    ]);

    const result = await fetchPullCommitsForItems({ fetch: fetchImpl, ...BASE_DEPS }, [
      { repo: "acme/widgets", number: 42 },
      { repo: "acme/gadgets", number: 7 },
    ]);

    expect(result).toEqual({
      "acme/widgets#42": ["2026-07-15T10:00:00Z"],
      "acme/gadgets#7": ["2026-07-16T10:00:00Z"],
    });
  });

  it("uses exactly owner/repo#number as the key format", async () => {
    const fetchImpl = routedFetch([
      {
        match: /\/repos\/acme\/widgets\/pulls\/42\/commits/,
        response: () => jsonResponse([]),
      },
    ]);

    const result = await fetchPullCommitsForItems({ fetch: fetchImpl, ...BASE_DEPS }, [
      { repo: "acme/widgets", number: 42 },
    ]);

    expect(Object.keys(result)).toEqual(["acme/widgets#42"]);
  });

  it("catches a single item's fetch failure, logs it, and omits that item from the result", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = routedFetch([
      {
        match: /\/repos\/acme\/broken\/pulls\/1\/commits/,
        response: () => new Response("server error", { status: 500 }),
      },
      {
        match: /\/repos\/acme\/widgets\/pulls\/42\/commits/,
        response: () => jsonResponse([rawPullCommit("sha1", "2026-07-15T10:00:00Z")]),
      },
    ]);

    const result = await fetchPullCommitsForItems({ fetch: fetchImpl, ...BASE_DEPS }, [
      { repo: "acme/broken", number: 1 },
      { repo: "acme/widgets", number: 42 },
    ]);

    expect(result).toEqual({ "acme/widgets#42": ["2026-07-15T10:00:00Z"] });
    expect(Object.hasOwn(result, "acme/broken#1")).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("truncates items exceeding 50 and warns, processing only the first 50", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = Array.from({ length: 51 }, (_, i) => ({ repo: `acme/repo${i}`, number: 1 }));
    const fetchImpl = routedFetch(
      items.map((_item, i) => ({
        match: new RegExp(`/repos/acme/repo${i}/pulls/1/commits`),
        response: () => jsonResponse([rawPullCommit(`sha-${i}`, "2026-07-15T10:00:00Z")]),
      })),
    );

    const result = await fetchPullCommitsForItems({ fetch: fetchImpl, ...BASE_DEPS }, items);

    expect(Object.keys(result)).toHaveLength(50);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(50);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns {} without making any fetch calls for an empty items array", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await fetchPullCommitsForItems({ fetch: fetchImpl, ...BASE_DEPS }, []);

    expect(result).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
