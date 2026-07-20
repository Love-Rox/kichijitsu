import { describe, expect, it, vi } from "vite-plus/test";
import { listWorkflowRuns } from "../src/github/workflow-runs";

function rawRun(
  overrides: Partial<{
    id: number;
    name: string | null;
    html_url: string;
    status: string;
    conclusion: string | null;
    created_at: string;
  }> = {},
) {
  return {
    id: overrides.id ?? 1,
    name: overrides.name === undefined ? "CI" : overrides.name,
    html_url: overrides.html_url ?? "https://github.com/acme/widgets/actions/runs/1",
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined ? "success" : overrides.conclusion,
    created_at: overrides.created_at ?? "2026-07-15T10:00:00Z",
  };
}

describe("listWorkflowRuns", () => {
  it("requests actions/runs with a created=since..until range and per_page=100", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 }),
      );

    await listWorkflowRuns(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    const [url] = fetchImpl.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/repos/acme/widgets/actions/runs");
    expect(parsed.searchParams.get("created")).toBe("2026-07-01T00:00:00Z..2026-07-31T00:00:00Z");
    expect(parsed.searchParams.get("per_page")).toBe("100");
  });

  it("maps id/name/htmlUrl/status/conclusion/createdAt to the DTO shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            rawRun({
              id: 42,
              name: "CI",
              html_url: "https://github.com/acme/widgets/actions/runs/42",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-07-15T10:00:00Z",
            }),
          ],
        }),
        { status: 200 },
      ),
    );

    const runs = await listWorkflowRuns(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(runs).toEqual([
      {
        id: 42,
        name: "CI",
        htmlUrl: "https://github.com/acme/widgets/actions/runs/42",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-07-15T10:00:00Z",
      },
    ]);
  });

  it("falls back to an empty string when the workflow name is null", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ total_count: 1, workflow_runs: [rawRun({ name: null })] }), {
        status: 200,
      }),
    );

    const runs = await listWorkflowRuns(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(runs[0].name).toBe("");
  });

  it("returns an empty array on 404 (repo not visible / Actions disabled) instead of throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const runs = await listWorkflowRuns(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(runs).toEqual([]);
  });

  it("propagates a non-404 non-ok response as GitHubApiError", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(
      listWorkflowRuns(
        fetchImpl,
        "token-abc",
        "acme",
        "widgets",
        "2026-07-01T00:00:00Z",
        "2026-07-31T00:00:00Z",
      ),
    ).rejects.toThrow(/401/);
  });

  it("truncates to the per-repo safety cap and warns when exceeded", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manyRuns = Array.from({ length: 201 }, (_, i) => rawRun({ id: i }));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ total_count: 201, workflow_runs: manyRuns }), {
        status: 200,
      }),
    );

    const runs = await listWorkflowRuns(
      fetchImpl,
      "token-abc",
      "acme",
      "widgets",
      "2026-07-01T00:00:00Z",
      "2026-07-31T00:00:00Z",
    );

    expect(runs).toHaveLength(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
