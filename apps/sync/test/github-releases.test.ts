import { describe, expect, it, vi } from "vite-plus/test";
import { listReleases } from "../src/github/releases";

function rawRelease(
  overrides: Partial<{
    tag_name: string;
    name: string | null;
    html_url: string;
    published_at: string | null;
    draft: boolean;
    prerelease: boolean;
  }> = {},
) {
  return {
    tag_name: overrides.tag_name ?? "v1.0.0",
    name: overrides.name === undefined ? "Version 1.0.0" : overrides.name,
    html_url: overrides.html_url ?? "https://github.com/acme/widgets/releases/tag/v1.0.0",
    published_at:
      overrides.published_at === undefined ? "2026-08-01T00:00:00Z" : overrides.published_at,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
  };
}

describe("listReleases", () => {
  it("requests releases with per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/releases");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it("maps tag_name/name/html_url/published_at/prerelease to the ReleaseInfo shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawRelease({ tag_name: "v2.0.0", name: "Version 2.0.0", prerelease: true }),
          ]),
          { status: 200 },
        ),
      );

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases).toEqual([
      {
        tagName: "v2.0.0",
        name: "Version 2.0.0",
        htmlUrl: "https://github.com/acme/widgets/releases/tag/v1.0.0",
        publishedAt: "2026-08-01T00:00:00Z",
        prerelease: true,
      },
    ]);
  });

  it("falls back name to tag_name when name is null", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify([rawRelease({ tag_name: "v3.0.0", name: null })]), {
        status: 200,
      }),
    );

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases[0].name).toBe("v3.0.0");
  });

  it("falls back name to tag_name when name is an empty string", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify([rawRelease({ tag_name: "v4.0.0", name: "" })]), {
        status: 200,
      }),
    );

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases[0].name).toBe("v4.0.0");
  });

  it("excludes draft releases", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawRelease({ tag_name: "v5.0.0-draft", draft: true }),
            rawRelease({ tag_name: "v5.0.0" }),
          ]),
          { status: 200 },
        ),
      );

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases.map((r) => r.tagName)).toEqual(["v5.0.0"]);
  });

  it("excludes releases with published_at null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawRelease({ tag_name: "v6.0.0-unpublished", published_at: null }),
            rawRelease({ tag_name: "v6.0.0" }),
          ]),
          { status: 200 },
        ),
      );

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases.map((r) => r.tagName)).toEqual(["v6.0.0"]);
  });

  it("returns an empty array on 404 (releases not visible) instead of throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases).toEqual([]);
  });

  it("propagates a non-404 non-ok response as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    await expect(listReleases(fetchImpl, "token-abc", "acme", "widgets")).rejects.toThrow(/500/);
  });

  it("truncates to the per-repo safety cap and warns when exceeded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manyReleases = Array.from({ length: 101 }, (_, i) =>
      rawRelease({ tag_name: `v0.0.${i}` }),
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manyReleases), { status: 200 }));

    const releases = await listReleases(fetchImpl, "token-abc", "acme", "widgets");

    expect(releases).toHaveLength(100);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
