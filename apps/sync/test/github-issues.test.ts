import { describe, expect, it, vi } from "vite-plus/test";
import { listOpenIssuesForMilestone } from "../src/github/issues";

function rawIssue(
  overrides: Partial<{
    number: number;
    title: string;
    html_url: string;
    pull_request: unknown;
  }> = {},
) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "Fix bug",
    html_url: overrides.html_url ?? "https://github.com/acme/widgets/issues/1",
    ...(overrides.pull_request !== undefined ? { pull_request: overrides.pull_request } : {}),
  };
}

describe("listOpenIssuesForMilestone", () => {
  it("requests open issues filtered by milestone with per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listOpenIssuesForMilestone(fetchImpl, "token-abc", "acme", "widgets", 7);

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/issues");
    expect(parsed.searchParams.get("milestone")).toBe("7");
    expect(parsed.searchParams.get("state")).toBe("open");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it("classifies items with a pull_request field as 'pr' and others as 'issue'", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawIssue({ number: 1, title: "Real issue" }),
            rawIssue({ number: 2, title: "A pull request", pull_request: { url: "..." } }),
          ]),
          { status: 200 },
        ),
      );

    const items = await listOpenIssuesForMilestone(fetchImpl, "token-abc", "acme", "widgets", 7);

    expect(items).toEqual([
      {
        number: 1,
        title: "Real issue",
        htmlUrl: "https://github.com/acme/widgets/issues/1",
        type: "issue",
      },
      {
        number: 2,
        title: "A pull request",
        htmlUrl: "https://github.com/acme/widgets/issues/1",
        type: "pr",
      },
    ]);
  });

  it("propagates a non-ok response as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    await expect(
      listOpenIssuesForMilestone(fetchImpl, "token-abc", "acme", "widgets", 7),
    ).rejects.toThrow(/500/);
  });
});
