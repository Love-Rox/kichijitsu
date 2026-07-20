/**
 * GitHub App の user-to-server OAuth (docs/github-oauth.md)。Google (src/google/oauth.ts) と
 * 違い、認可 URL に `scope` を載せない — GitHub App は App 定義の Permissions が権限を決める
 * ため、OAuth の scope パラメータ自体を使わない。
 *
 * 「Expire user authorization tokens」を GitHub App 側でオフにする運用前提 (docs/github-oauth.md
 * の手作業手順参照) なので、access_token は無期限で refresh_token は発行されない。
 * 将来オンにして期限付きトークン + refresh に切り替える場合は、Google の
 * refreshAccessToken 相当をここに追加する余地を残してある (ExchangedGitHubTokens に
 * expiresIn / refreshToken を足し、期限切れ時に再認可 or refresh するフローを追加する)。
 */

const AUTH_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";

// GitHub API は User-Agent が無いリクエストを拒否するため必須。
const USER_AGENT = "kichijitsu";

export interface GitHubAuthorizeConfig {
  clientId: string;
}

export function buildGitHubAuthorizationUrl(
  config: GitHubAuthorizeConfig,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface ExchangedGitHubTokens {
  accessToken: string;
  /** GitHub App の Permissions に対応する scope 相当の文字列。空/無いこともある。 */
  scope?: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  // GitHub はエラー時も HTTP 200 + JSON body で `error` / `error_description` を返す
  // (HTTP ステータスではエラーを表現しない)。
  error?: string;
  error_description?: string;
}

export async function exchangeGitHubCode(
  fetchFn: typeof fetch,
  config: GitHubOAuthConfig,
  code: string,
  redirectUri: string,
): Promise<ExchangedGitHubTokens> {
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub token exchange failed: HTTP ${response.status}: ${await response.text()}`,
    );
  }
  const data = (await response.json()) as GitHubTokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(
      `GitHub token exchange failed: ${data.error ?? "missing_access_token"}${
        data.error_description ? ` (${data.error_description})` : ""
      }`,
    );
  }
  return { accessToken: data.access_token, scope: data.scope };
}

export interface GitHubUser {
  id: number;
  login: string;
}

export async function fetchGitHubUser(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<GitHubUser> {
  const response = await fetchFn(USER_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: HTTP ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}
