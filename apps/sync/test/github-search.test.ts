import { describe, expect, it, vi } from "vite-plus/test";
import {
  isPullRequestSearchItem,
  ownerRepoFromRepositoryUrl,
  searchIssues,
} from "../src/github/search";
import { GitHubApiError, githubHeaders } from "../src/github/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("searchIssues", () => {
  it("requests /search/issues with q, per_page, sort and order, and returns items", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        total_count: 1,
        items: [
          {
            number: 42,
            title: "Fix the thing",
            html_url: "https://github.com/acme/widgets/issues/42",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const result = await searchIssues(fetchImpl, "token-abc", "is:open is:issue assignee:@me");

    expect(result).toEqual({
      totalCount: 1,
      items: [
        {
          number: 42,
          title: "Fix the thing",
          html_url: "https://github.com/acme/widgets/issues/42",
          repository_url: "https://api.github.com/repos/acme/widgets",
          updated_at: "2026-07-01T00:00:00Z",
        },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/search/issues?q=is%3Aopen%20is%3Aissue%20assignee%3A%40me&per_page=50&sort=updated&order=desc",
    );
    expect((init as RequestInit).headers).toEqual(githubHeaders("token-abc"));
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(searchIssues(fetchImpl, "token-abc", "is:open is:pr author:@me")).rejects.toThrow(
      GitHubApiError,
    );
  });

  it("warns and still returns items when total_count exceeds the fetched page", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        total_count: 120,
        items: [
          {
            number: 1,
            title: "Only item on this page",
            html_url: "https://github.com/acme/widgets/issues/1",
            repository_url: "https://api.github.com/repos/acme/widgets",
            updated_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const result = await searchIssues(fetchImpl, "token-abc", "is:open is:pr review-requested:@me");

    expect(result.totalCount).toBe(120);
    expect(result.items).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("truncating");
    warnSpy.mockRestore();
  });

  it("does not warn when total_count matches the fetched page", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ total_count: 0, items: [] }));

    await searchIssues(fetchImpl, "token-abc", "is:open is:pr author:@me");

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("isPullRequestSearchItem", () => {
  it("returns true when pull_request is present", () => {
    expect(
      isPullRequestSearchItem({
        number: 1,
        title: "x",
        html_url: "https://x",
        repository_url: "https://api.github.com/repos/acme/widgets",
        updated_at: "2026-07-01T00:00:00Z",
        pull_request: { url: "..." },
      }),
    ).toBe(true);
  });

  it("returns false when pull_request is absent", () => {
    expect(
      isPullRequestSearchItem({
        number: 1,
        title: "x",
        html_url: "https://x",
        repository_url: "https://api.github.com/repos/acme/widgets",
        updated_at: "2026-07-01T00:00:00Z",
      }),
    ).toBe(false);
  });
});

describe("ownerRepoFromRepositoryUrl", () => {
  it("derives owner/repo from a repository_url", () => {
    expect(ownerRepoFromRepositoryUrl("https://api.github.com/repos/acme/widgets")).toBe(
      "acme/widgets",
    );
  });

  it("throws on an unexpected format", () => {
    expect(() => ownerRepoFromRepositoryUrl("not-a-url")).toThrow();
  });
});
