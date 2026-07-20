import { describe, expect, it, vi } from "vite-plus/test";
import { listInstallationRepos } from "../src/github/installations";

function installationsResponse(ids: number[]) {
  return new Response(
    JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }),
    { status: 200 },
  );
}

function reposResponse(repos: { owner: string; name: string }[]) {
  return new Response(
    JSON.stringify({
      total_count: repos.length,
      repositories: repos.map((r) => ({ name: r.name, owner: { login: r.owner } })),
    }),
    { status: 200 },
  );
}

describe("listInstallationRepos", () => {
  it("lists /user/installations then /user/installations/{id}/repositories for each installation", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(installationsResponse([1, 2]))
      .mockResolvedValueOnce(reposResponse([{ owner: "acme", name: "widgets" }]))
      .mockResolvedValueOnce(reposResponse([{ owner: "acme", name: "gadgets" }]));

    const repos = await listInstallationRepos(fetchImpl, "token-abc");

    expect(repos).toEqual([
      { owner: "acme", repo: "widgets" },
      { owner: "acme", repo: "gadgets" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toContain("/user/installations");
    expect(fetchImpl.mock.calls[1][0]).toContain("/user/installations/1/repositories");
    expect(fetchImpl.mock.calls[2][0]).toContain("/user/installations/2/repositories");
  });

  it('follows Link: rel="next" pagination for both installations and repositories', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 2, installations: [{ id: 1 }] }), {
          status: 200,
          headers: { Link: '<https://api.github.com/user/installations?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(installationsResponse([2]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [{ name: "widgets", owner: { login: "acme" } }],
          }),
          {
            status: 200,
            headers: {
              Link: '<https://api.github.com/user/installations/1/repositories?page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(reposResponse([{ owner: "acme", name: "sprockets" }]))
      .mockResolvedValueOnce(reposResponse([{ owner: "acme", name: "gadgets" }]));

    const repos = await listInstallationRepos(fetchImpl, "token-abc");

    expect(repos).toEqual([
      { owner: "acme", repo: "widgets" },
      { owner: "acme", repo: "sprockets" },
      { owner: "acme", repo: "gadgets" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("returns an empty array when there are no installations", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(installationsResponse([]));

    const repos = await listInstallationRepos(fetchImpl, "token-abc");

    expect(repos).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("truncates at the safety cap and warns instead of throwing", async () => {
    const manyRepos = Array.from({ length: 150 }, (_, i) => ({ owner: "acme", name: `repo-${i}` }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(installationsResponse([1]))
      .mockResolvedValueOnce(reposResponse(manyRepos));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const repos = await listInstallationRepos(fetchImpl, "token-abc");

    expect(repos).toHaveLength(100);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
