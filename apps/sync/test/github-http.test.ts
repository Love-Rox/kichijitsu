import { describe, expect, it, vi } from "vite-plus/test";
import { GitHubApiError, fetchAllPages, githubHeaders, parseNextLink } from "../src/github/http";

describe("githubHeaders", () => {
  it("sets Authorization, User-Agent and Accept headers", () => {
    expect(githubHeaders("gho_abc123")).toEqual({
      Authorization: "Bearer gho_abc123",
      "User-Agent": "kichijitsu",
      Accept: "application/vnd.github+json",
    });
  });
});

describe("parseNextLink", () => {
  it('extracts rel="next" from a multi-entry Link header', () => {
    const header =
      '<https://api.github.com/resource?page=2>; rel="next", <https://api.github.com/resource?page=5>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/resource?page=2");
  });

  it('returns undefined when there is no rel="next"', () => {
    const header = '<https://api.github.com/resource?page=1>; rel="prev"';
    expect(parseNextLink(header)).toBeUndefined();
  });

  it("returns undefined for a null header", () => {
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("fetchAllPages", () => {
  it("returns items from a single page when there is no next link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200 }));

    const items = await fetchAllPages<{ id: number }>(
      fetchImpl,
      "https://api.github.com/resource",
      "token-abc",
      (body) => body as { id: number }[],
    );

    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect((init as RequestInit).headers).toEqual(githubHeaders("token-abc"));
  });

  it('follows rel="next" across pages and combines results', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: { Link: '<https://api.github.com/resource?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));

    const items = await fetchAllPages<{ id: number }>(
      fetchImpl,
      "https://api.github.com/resource",
      "token-abc",
      (body) => body as { id: number }[],
    );

    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.github.com/resource?page=2");
  });

  it("throws GitHubApiError on a non-ok response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(
      fetchAllPages(
        fetchImpl,
        "https://api.github.com/resource",
        "token-abc",
        (body) => body as [],
      ),
    ).rejects.toThrow(GitHubApiError);
  });
});
