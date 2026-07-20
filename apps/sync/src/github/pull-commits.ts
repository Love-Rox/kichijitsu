import { fetchAllPages, GITHUB_API_BASE, GitHubApiError } from "./http";

/**
 * 指定 PR の commits API (docs/github-integration.md フェーズ③「時間計測」Part A)。
 * PR に積まれた commit のうち、自分 (authorLogin) がコミットしたものだけの時刻を返す
 * (クライアント側でのクラスタリングによる実績時間推定の入力になる)。
 */

interface RawPullCommit {
  sha: string;
  commit: {
    author?: { date?: string };
    committer?: { date?: string };
  };
  // トップレベルの author は GitHub ユーザーオブジェクト (commit.author の git-identity とは別物)。
  // フォーク由来など GitHub アカウントに紐付かない commit では null になり得る。
  author: { login: string } | null;
}

/**
 * 1 PR あたりの安全上限。github/commits.ts の MAX_COMMITS_PER_REPO と同じ「まず全部取って
 * から上限で切る」流儀 (フィルタ前の生リストの長さで判定する)。
 */
const MAX_COMMITS_PER_PR = 250;

/**
 * `GET /repos/{owner}/{repo}/pulls/{number}/commits`。
 *
 * - author.login === authorLogin の commit だけを残す (author が null のものは名前/メール
 *   での突合を試みず除外する)。
 * - タイムスタンプは commit.author.date、無ければ commit.committer.date。どちらも無ければ
 *   その commit 自体をスキップする (github/commits.ts と違い、フィルタ後の commit にまで
 *   GitHub が必ず author date を付けている保証はないため防御的に扱う)。
 * - 404 (PR が見えない/消えた) は例外にせず空配列で握る — github/commits.ts の 404 処理と
 *   同じ考え方。409 は PR commits エンドポイントには存在しないので扱わない。
 * - それ以外の非 2xx は GitHubApiError のまま伝播させる。
 */
export async function listPullCommitTimestamps(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  number: number,
  authorLogin: string,
): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;

  let raw: RawPullCommit[];
  try {
    raw = await fetchAllPages<RawPullCommit>(
      fetchFn,
      url,
      token,
      (body) => body as RawPullCommit[],
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return [];
    }
    throw err;
  }

  if (raw.length > MAX_COMMITS_PER_PR) {
    console.warn(
      `listPullCommitTimestamps: ${owner}/${repo}#${number} returned ${raw.length} commit(s), ` +
        `exceeding the safety cap of ${MAX_COMMITS_PER_PR}; truncating`,
    );
    raw = raw.slice(0, MAX_COMMITS_PER_PR);
  }

  const timestamps: string[] = [];
  for (const c of raw) {
    if (c.author === null || c.author.login !== authorLogin) continue;
    const timestamp = c.commit.author?.date ?? c.commit.committer?.date;
    if (!timestamp) continue;
    timestamps.push(timestamp);
  }

  timestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
  return timestamps;
}
