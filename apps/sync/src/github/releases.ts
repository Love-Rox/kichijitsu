import { fetchAllPages, GITHUB_API_BASE, GitHubApiError } from "./http";

/**
 * リポジトリの公開済み release 一覧 (docs/github-integration.md フェーズ④「first cut」、
 * 2026-07-20)。milestone/issue/PR とは独立した GitHub アイテムとして GitHub レーンに
 * 表示する。CI/Actions (別フェーズ) は対象外。
 */
export interface ReleaseInfo {
  tagName: string;
  name: string;
  htmlUrl: string;
  /** ISO 8601 (GitHub の published_at)。呼び出し元で epoch ms に変換する。 */
  publishedAt: string;
  prerelease: boolean;
}

interface RawRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

/**
 * 1 repo あたりの安全上限。per_page=100 と組み合わせても、release を大量に切っている repo
 * では際限なくページが続き得るため、取得後に打ち切る (listCommits の MAX_COMMITS_PER_REPO
 * と同じ「まず全部取ってから上限で切る」流儀)。
 */
const MAX_RELEASES_PER_REPO = 100;

/**
 * `GET /repos/{owner}/{repo}/releases`。
 *
 * - 404 (repo が見えない/release 未使用) は例外にせず空配列で握る (listCommits と同じ方針)。
 *   それ以外の非 2xx は GitHubApiError のまま伝播させる。
 * - draft (未公開、日時が確定していない) と published_at が無いものは除外する。
 */
export async function listReleases(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
): Promise<ReleaseInfo[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/releases?per_page=100`;

  let raw: RawRelease[];
  try {
    raw = await fetchAllPages<RawRelease>(fetchFn, url, token, (body) => body as RawRelease[]);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return [];
    }
    throw err;
  }

  if (raw.length > MAX_RELEASES_PER_REPO) {
    console.warn(
      `listReleases: ${owner}/${repo} returned ${raw.length} release(s), exceeding the safety cap ` +
        `of ${MAX_RELEASES_PER_REPO}; truncating`,
    );
    raw = raw.slice(0, MAX_RELEASES_PER_REPO);
  }

  return raw
    .filter((r): r is RawRelease & { published_at: string } => !r.draft && r.published_at != null)
    .map((r) => ({
      tagName: r.tag_name,
      name: r.name && r.name.length > 0 ? r.name : r.tag_name,
      htmlUrl: r.html_url,
      publishedAt: r.published_at,
      prerelease: r.prerelease,
    }));
}
