import { githubHeaders, GITHUB_API_BASE, GitHubApiError } from "./http";

/**
 * GitHub Search API (`GET /search/issues`) 呼び出し (docs/github-integration.md フェーズ②
 * 「作業キュー」)。milestone/issues 系 (github/issues.ts 等) と違い横断検索なので、
 * per-repo 列挙ではなくこちらを使う。
 */

/** `/search/issues` のレスポンス item (issue/PR 共通形。必要フィールドのみ)。 */
export interface GitHubSearchItem {
  number: number;
  title: string;
  html_url: string;
  /** PR にだけ付く。中身は使わず有無だけ見る (github/issues.ts の RawIssue と同じ流儀)。 */
  pull_request?: unknown;
  /** 例: `https://api.github.com/repos/owner/repo` */
  repository_url: string;
  updated_at: string;
}

interface SearchIssuesResponseBody {
  total_count: number;
  items?: GitHubSearchItem[];
}

export interface SearchIssuesResult {
  totalCount: number;
  items: GitHubSearchItem[];
}

/**
 * Search API のレート制限 (30 req/min) と「作業キューは今の作業一覧で足りる」という
 * 判断から、1ページ目のみ取得する (全ページ走査はしない)。
 */
const PER_PAGE = 50;

/**
 * `q` を1ページ (per_page=50、updated 降順) だけ取得する。ページングは行わない —
 * `totalCount` が返した件数を超える場合は切り捨てが起きたことを示すので、呼び出し元が
 * 気付けるよう console.warn で明示する (握りつぶさず継続はする — 作業キューの1クエリが
 * 多いだけで全体を落とす理由にはならない)。
 */
export async function searchIssues(
  fetchFn: typeof fetch,
  token: string,
  query: string,
): Promise<SearchIssuesResult> {
  const url = `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}&sort=updated&order=desc`;
  const response = await fetchFn(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new GitHubApiError(response.status, await response.text());
  }
  const body = (await response.json()) as SearchIssuesResponseBody;
  const items = body.items ?? [];

  if (body.total_count > items.length) {
    console.warn(
      `searchIssues: query "${query}" matched ${body.total_count} item(s) but only the first ` +
        `${items.length} were fetched (single page, per_page=${PER_PAGE}); truncating`,
    );
  }

  return { totalCount: body.total_count, items };
}

/** `pull_request` フィールドの有無で PR/issue を判定する (github/issues.ts と同じ流儀)。 */
export function isPullRequestSearchItem(item: GitHubSearchItem): boolean {
  return item.pull_request !== undefined;
}

/**
 * `repository_url` (`https://api.github.com/repos/owner/repo`) から `owner/repo` を導出する。
 * 想定外の形式なら Error を投げる (呼び出し元判断で握りつぶすかどうか決める)。
 */
export function ownerRepoFromRepositoryUrl(repositoryUrl: string): string {
  const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  if (!match) {
    throw new Error(`ownerRepoFromRepositoryUrl: unexpected repository_url: "${repositoryUrl}"`);
  }
  return match[1];
}
