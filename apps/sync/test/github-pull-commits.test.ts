import { describe, expect, it, vi } from "vite-plus/test";
import { listPullCommitTimestamps } from "../src/github/pull-commits";

function rawPullCommit(
  overrides: Partial<{
    sha: string;
    authorLogin: string | null;
    authorDate: string | null;
    committerDate: string | null;
  }> = {},
) {
  return {
    sha: overrides.sha ?? "abc123",
    commit: {
      ...(overrides.authorDate !== undefined
        ? overrides.authorDate === null
          ? {}
          : { author: { date: overrides.authorDate } }
        : { author: { date: "2026-07-15T10:00:00Z" } }),
      ...(overrides.committerDate !== undefined
        ? overrides.committerDate === null
          ? {}
          : { committer: { date: overrides.committerDate } }
        : {}),
    },
    author:
      overrides.authorLogin === undefined
        ? { login: "octocat" }
        : overrides.authorLogin === null
          ? null
          : { login: overrides.authorLogin },
  };
}

describe("listPullCommitTimestamps", () => {
  it("requests the PR commits endpoint with per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listPullCommitTimestamps(fetchImpl, "token-abc", "acme", "widgets", 42, "octocat");

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/pulls/42/commits");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it('follows Link: rel="next" across multiple pages', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([rawPullCommit({ sha: "sha1" })]), {
          status: 200,
          headers: {
            Link: '<https://api.github.com/repos/acme/widgets/pulls/42/commits?page=2>; rel="next"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([rawPullCommit({ sha: "sha2" })]), { status: 200 }),
      );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timestamps).toHaveLength(2);
  });

  it("keeps commits where author.login matches authorLogin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          rawPullCommit({
            sha: "sha1",
            authorLogin: "octocat",
            authorDate: "2026-07-15T10:00:00Z",
          }),
        ]),
        { status: 200 },
      ),
    );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual(["2026-07-15T10:00:00Z"]);
  });

  it("excludes commits where author.login differs from authorLogin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify([rawPullCommit({ authorLogin: "someone-else" })]), {
        status: 200,
      }),
    );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual([]);
  });

  it("excludes commits where author is null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([rawPullCommit({ authorLogin: null })]), { status: 200 }),
      );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual([]);
  });

  it("falls back to commit.committer.date when commit.author.date is absent", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawPullCommit({ authorDate: null, committerDate: "2026-07-16T09:00:00Z" }),
          ]),
          { status: 200 },
        ),
      );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual(["2026-07-16T09:00:00Z"]);
  });

  it("skips a commit with neither commit.author.date nor commit.committer.date", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify([rawPullCommit({ authorDate: null, committerDate: null })]), {
        status: 200,
      }),
    );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual([]);
  });

  it("returns timestamps sorted ascending regardless of input order", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawPullCommit({ sha: "sha1", authorDate: "2026-07-16T10:00:00Z" }),
            rawPullCommit({ sha: "sha2", authorDate: "2026-07-14T10:00:00Z" }),
            rawPullCommit({ sha: "sha3", authorDate: "2026-07-15T10:00:00Z" }),
          ]),
          { status: 200 },
        ),
      );

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual([
      "2026-07-14T10:00:00Z",
      "2026-07-15T10:00:00Z",
      "2026-07-16T10:00:00Z",
    ]);
  });

  it("returns an empty array on 404 (PR not visible) instead of throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toEqual([]);
  });

  it("propagates a non-404 error status as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(
      listPullCommitTimestamps(fetchImpl, "token-abc", "acme", "widgets", 42, "octocat"),
    ).rejects.toThrow(/401/);
  });

  it("propagates a 500 error status as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    await expect(
      listPullCommitTimestamps(fetchImpl, "token-abc", "acme", "widgets", 42, "octocat"),
    ).rejects.toThrow(/500/);
  });

  it("truncates to the per-PR safety cap and warns when exceeded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manyCommits = Array.from({ length: 251 }, (_, i) => rawPullCommit({ sha: `sha-${i}` }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manyCommits), { status: 200 }));

    const timestamps = await listPullCommitTimestamps(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      42,
      "octocat",
    );

    expect(timestamps).toHaveLength(250);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
