/**
 * GitHub REST API 呼び出しの共通処理 (docs/github-integration.md フェーズ①)。
 * github/oauth.ts と同じ流儀 (fetch 注入、User-Agent 必須) を踏襲しつつ、
 * installations/milestones/issues の一覧系エンドポイントが共通で必要とする
 * ヘッダー組み立てとページング (Link ヘッダーの rel="next" を辿る) をここに集約する。
 */

export const GITHUB_API_BASE = "https://api.github.com";

// GitHub API は User-Agent が無いリクエストを拒否するため必須 (github/oauth.ts と同じ)。
const USER_AGENT = "kichijitsu";

export function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
}

/** GitHub REST API がエラーを返した (401/403/404/5xx など)。呼び出し元まで伝播させる。 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`GitHub API error: HTTP ${status}: ${body}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

/** `Link: <url>; rel="next", <url>; rel="last"` のような値から rel="next" の URL を取り出す。 */
export function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * GET リクエストを `Link: rel="next"` が無くなるまで辿り、各ページの JSON body から
 * `extractItems` で取り出した要素を1つの配列に集約する。GitHub REST の一覧系エンドポイント
 * (installations / repositories / milestones / issues) は全てこの形でページングされる
 * (per_page=100 と組み合わせても、件数が多いレポジトリでは複数ページに分かれ得る)。
 */
export async function fetchAllPages<T>(
  fetchFn: typeof fetch,
  initialUrl: string,
  token: string,
  extractItems: (body: unknown) => T[],
): Promise<T[]> {
  const items: T[] = [];
  let url: string | undefined = initialUrl;
  while (url) {
    const response = await fetchFn(url, { headers: githubHeaders(token) });
    if (!response.ok) {
      throw new GitHubApiError(response.status, await response.text());
    }
    const body: unknown = await response.json();
    items.push(...extractItems(body));
    url = parseNextLink(response.headers.get("Link"));
  }
  return items;
}
