import { describe, expect, it, vi } from "vite-plus/test";
import { listOpenMilestones } from "../src/github/milestones";

function rawMilestone(
  overrides: Partial<{
    number: number;
    title: string;
    due_on: string | null;
    html_url: string;
  }> = {},
) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "v1.0",
    due_on: overrides.due_on === undefined ? "2026-08-01T00:00:00Z" : overrides.due_on,
    html_url: overrides.html_url ?? "https://github.com/acme/widgets/milestone/1",
  };
}

describe("listOpenMilestones", () => {
  it("requests open milestones with per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listOpenMilestones(fetchImpl, "token-abc", "acme", "widgets");

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/milestones");
    expect(parsed.searchParams.get("state")).toBe("open");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it("maps due_on/title/number/html_url to the DTO shape", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([rawMilestone({ number: 7, title: "Beta" })]), { status: 200 }),
      );

    const milestones = await listOpenMilestones(fetchImpl, "token-abc", "acme", "widgets");

    expect(milestones).toEqual([
      {
        number: 7,
        title: "Beta",
        dueOn: "2026-08-01T00:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/milestone/1",
      },
    ]);
  });

  it("excludes milestones without a due_on", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            rawMilestone({ number: 1, due_on: null }),
            rawMilestone({ number: 2, due_on: "2026-09-01T00:00:00Z" }),
          ]),
          { status: 200 },
        ),
      );

    const milestones = await listOpenMilestones(fetchImpl, "token-abc", "acme", "widgets");

    expect(milestones.map((m) => m.number)).toEqual([2]);
  });

  it("propagates a non-ok response as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));

    await expect(listOpenMilestones(fetchImpl, "token-abc", "acme", "widgets")).rejects.toThrow(
      /404/,
    );
  });
});
