import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUser,
} from "../src/github/oauth";

describe("buildGitHubAuthorizationUrl", () => {
  it("builds the authorize URL without a scope parameter (GitHub App permissions decide access)", () => {
    const url = buildGitHubAuthorizationUrl(
      { clientId: "client-123" },
      "state-abc",
      "http://localhost:8787/auth/github/callback",
    );
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("state")).toBe("state-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/auth/github/callback",
    );
    expect(parsed.searchParams.has("scope")).toBe(false);
  });
});

describe("exchangeGitHubCode", () => {
  const CONFIG = { clientId: "client-123", clientSecret: "secret-456" };

  it("exchanges a code for an access token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "gho_abc123", scope: "", token_type: "bearer" }),
        {
          status: 200,
        },
      ),
    );

    const result = await exchangeGitHubCode(
      fetchImpl,
      CONFIG,
      "code-xyz",
      "http://localhost:8787/auth/github/callback",
    );

    expect(result).toEqual({ accessToken: "gho_abc123", scope: "" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    expect((request.headers as Record<string, string>).Accept).toBe("application/json");
    const body = request.body as URLSearchParams;
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("client_secret")).toBe("secret-456");
    expect(body.get("code")).toBe("code-xyz");
    expect(body.get("redirect_uri")).toBe("http://localhost:8787/auth/github/callback");
  });

  it("throws when GitHub returns a 200 with an error body (GitHub does not use HTTP status for OAuth errors)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "bad_verification_code", error_description: "expired" }),
          { status: 200 },
        ),
      );

    await expect(
      exchangeGitHubCode(
        fetchImpl,
        CONFIG,
        "stale-code",
        "http://localhost:8787/auth/github/callback",
      ),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it("throws when the HTTP response itself is non-2xx", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }));

    await expect(
      exchangeGitHubCode(
        fetchImpl,
        CONFIG,
        "code-xyz",
        "http://localhost:8787/auth/github/callback",
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("fetchGitHubUser", () => {
  it("fetches the user with the required headers (User-Agent is mandatory for the GitHub API)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: "octocat" }), { status: 200 }),
      );

    const user = await fetchGitHubUser(fetchImpl, "gho_abc123");

    expect(user).toEqual({ id: 42, login: "octocat" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gho_abc123");
    expect(headers["User-Agent"]).toBe("kichijitsu");
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));

    await expect(fetchGitHubUser(fetchImpl, "invalid-token")).rejects.toThrow(/HTTP 401/);
  });
});
