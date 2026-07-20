import { fetchAllPages, GITHUB_API_BASE, GitHubApiError } from "./http";

/**
 * 指定 repo の commits API (author + since/until で範囲限定、docs/github-integration.md
 * フェーズ③「実績オーバーレイ」Part A)。events API (private が漏れる/公開限定) ではなく、
 * インストール先 repo に対して `author` + `since`/`until` で有界に取れるこちらを使う方針。
 */
export interface CommitInfo {
  sha: string;
  /** commit message の先頭行のみ (本文は使わない)。 */
  message: string;
  htmlUrl: string;
  /** ISO 8601。commit.author.date、無ければ commit.committer.date。 */
  timestamp: string;
}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { date?: string };
    committer?: { date?: string };
  };
}

/**
 * 1 repo あたりの安全上限。since/until で範囲限定していても、対象 repo が非常に活発だと
 * ページが際限なく続き得るため、取得後に打ち切る (listInstallationRepos の MAX_REPOS と
 * 同じ「まず全部取ってから上限で切る」流儀)。
 */
const MAX_COMMITS_PER_REPO = 300;

/**
 * `GET /repos/{owner}/{repo}/commits?author=&since=&until=`。
 *
 * - 404 (repo が見えない) / 409 (空リポジトリ = commit が1つも無い) は例外にせず空配列で握る
 *   — 呼び出し元 (core/github-activity.ts) が該当 repo をスキップできるようにするため。
 * - それ以外の非 2xx は GitHubApiError のまま伝播させる (401 は呼び出し元でトークン失効
 *   判定に使う)。
 */
export async function listCommits(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  author: string,
  sinceIso: string,
  untilIso: string,
): Promise<CommitInfo[]> {
  const params = new URLSearchParams({
    author,
    since: sinceIso,
    until: untilIso,
    per_page: "100",
  });
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits?${params.toString()}`;

  let raw: RawCommit[];
  try {
    raw = await fetchAllPages<RawCommit>(fetchFn, url, token, (body) => body as RawCommit[]);
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 409)) {
      return [];
    }
    throw err;
  }

  if (raw.length > MAX_COMMITS_PER_REPO) {
    console.warn(
      `listCommits: ${owner}/${repo} returned ${raw.length} commit(s), exceeding the safety cap ` +
        `of ${MAX_COMMITS_PER_REPO} for the range ${sinceIso}..${untilIso}; truncating`,
    );
    raw = raw.slice(0, MAX_COMMITS_PER_REPO);
  }

  return raw.map((c) => ({
    sha: c.sha,
    message: c.commit.message.split("\n")[0],
    htmlUrl: c.html_url,
    timestamp: c.commit.author?.date ?? c.commit.committer?.date ?? "",
  }));
}
