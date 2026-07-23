import { describe, expect, it, vi } from "vite-plus/test";
import {
  listOpenRepoIssues,
  mapRawIssuesToRepoIssues,
  parseOwnerRepo,
} from "../src/github/repo-issues";

describe("mapRawIssuesToRepoIssues", () => {
  it("issue と PR を pull_request の有無で type 判定して map する", () => {
    const issues = mapRawIssuesToRepoIssues([
      { number: 10, title: "Fix crash" },
      { number: 11, title: "Add feature", pull_request: { url: "..." } },
    ]);
    expect(issues).toEqual([
      { number: 10, title: "Fix crash", type: "issue" },
      { number: 11, title: "Add feature", type: "pr" },
    ]);
  });

  it("空配列はそのまま空配列を返す", () => {
    expect(mapRawIssuesToRepoIssues([])).toEqual([]);
  });
});

describe("parseOwnerRepo", () => {
  it("owner/repo を分解する", () => {
    expect(parseOwnerRepo("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("owner のみ・repo のみ・空は null", () => {
    expect(parseOwnerRepo("acme")).toBeNull();
    expect(parseOwnerRepo("acme/")).toBeNull();
    expect(parseOwnerRepo("/widgets")).toBeNull();
    expect(parseOwnerRepo("")).toBeNull();
  });

  it('"/" が複数ある (owner/repo/extra) は null', () => {
    expect(parseOwnerRepo("acme/widgets/extra")).toBeNull();
  });
});

function issuesResponse(items: { number: number; title: string; isPr?: boolean }[]) {
  return new Response(
    JSON.stringify(
      items.map((i) => ({
        number: i.number,
        title: i.title,
        ...(i.isPr ? { pull_request: { url: "..." } } : {}),
      })),
    ),
    { status: 200 },
  );
}

describe("listOpenRepoIssues", () => {
  it("state=open で issue/PR を取得し DTO に map する", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        issuesResponse([
          { number: 10, title: "Fix crash" },
          { number: 11, title: "Add feature", isPr: true },
        ]),
      );

    const issues = await listOpenRepoIssues(fetchImpl, "token-abc", "acme", "widgets");

    expect(issues).toEqual([
      { number: 10, title: "Fix crash", type: "issue" },
      { number: 11, title: "Add feature", type: "pr" },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toContain("/repos/acme/widgets/issues?state=open");
  });

  it("安全上限を超えたら切り捨てて warn する", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ number: i, title: `#${i}` }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(issuesResponse(many));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const issues = await listOpenRepoIssues(fetchImpl, "token-abc", "acme", "widgets");

    expect(issues).toHaveLength(200);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
