import { describe, expect, it, vi } from "vite-plus/test";
import { listCommits } from "../src/github/commits";

function rawCommit(
  overrides: Partial<{
    sha: string;
    html_url: string;
    message: string;
    authorDate: string | null;
    committerDate: string | null;
  }> = {},
) {
  return {
    sha: overrides.sha ?? "abc123",
    html_url: overrides.html_url ?? "https://github.com/acme/widgets/commit/abc123",
    commit: {
      message: overrides.message ?? "Fix crash",
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
  };
}

describe("listCommits", () => {
  it("requests commits with author/since/until/per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/commits");
    expect(parsed.searchParams.get("author")).toBe("octocat");
    expect(parsed.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(parsed.searchParams.get("until")).toBe("2026-07-31T00:00:00Z");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it("extracts only the first line of the commit message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([rawCommit({ message: "Fix crash\n\nLonger body explaining why." })]),
          { status: 200 },
        ),
      );

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits[0].message).toBe("Fix crash");
  });

  it("falls back to commit.committer.date when commit.author.date is absent", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([rawCommit({ authorDate: null, committerDate: "2026-07-16T09:00:00Z" })]),
          { status: 200 },
        ),
      );

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits[0].timestamp).toBe("2026-07-16T09:00:00Z");
  });

  it("maps sha/message/htmlUrl/timestamp to the DTO shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([rawCommit({ sha: "deadbeef" })]), { status: 200 }),
      );

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits).toEqual([
      {
        sha: "deadbeef",
        message: "Fix crash",
        htmlUrl: "https://github.com/acme/widgets/commit/abc123",
        timestamp: "2026-07-15T10:00:00Z",
      },
    ]);
  });

  it("returns an empty array on 404 (repo not visible) instead of throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits).toEqual([]);
  });

  it("returns an empty array on 409 (empty repository) instead of throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Git Repository is empty.", { status: 409 }));

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits).toEqual([]);
  });

  it("propagates a non-404/409 non-ok response as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(
      listCommits(
        fetchImpl,
        "token-abc",
        "acme",
        "widgets",
        "octocat",
        "2026-07-01T00:00:00Z",
        "2026-07-31T00:00:00Z",
      ),
    ).rejects.toThrow(/401/);
  });

  it("truncates to the per-repo safety cap and warns when exceeded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manyCommits = Array.from({ length: 301 }, (_, i) => rawCommit({ sha: `sha-${i}` }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manyCommits), { status: 200 }));

    const commits = await listCommits(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "octocat",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(commits).toHaveLength(300);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
