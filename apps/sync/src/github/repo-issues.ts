import type { GitHubRepoIssue } from "@kichijitsu/shared";
import { fetchAllPages, GITHUB_API_BASE } from "./http";

/**
 * 1 リポジトリの open な issue / PR 一覧 (実績 UX 刷新フェーズ3「手動追加フォームのプルダウン
 * 化」、2026-07-23)。WorkLogModal の issue/PR プルダウンの選択肢に使う。GitHub の
 * `GET /repos/{owner}/{repo}/issues?state=open` は PR も含む — github/issues.ts の
 * listOpenIssuesForMilestone と同じく `pull_request` フィールドの有無で type を 'issue' / 'pr' に
 * 分ける (milestone で絞らず repo 全体の open を取る点だけが違う)。
 *
 * 合計件数に安全上限 (MAX_ISSUES) を設ける — issue の多い repo で反復・レスポンスが膨らむのを
 * 防ぐため (github/installations.ts の MAX_REPOS と同じ考え方)。超過分は切り捨て、console.warn で
 * 1度だけ知らせる (呼び出し元を落とすほどの異常ではない)。
 */
const MAX_ISSUES = 200;

interface RawIssue {
  number: number;
  title: string;
  /** issues エンドポイントでは PR にだけこのフィールドが付く。中身は使わず有無だけ見る。 */
  pull_request?: unknown;
}

/**
 * 純関数。`GET /repos/{o}/{r}/issues` の生レスポンス配列を GitHubRepoIssue[] に map する。
 * `pull_request` フィールドの有無で type を 'pr' / 'issue' に分ける (無ければ issue)。
 */
export function mapRawIssuesToRepoIssues(raw: RawIssue[]): GitHubRepoIssue[] {
  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    type: issue.pull_request !== undefined ? "pr" : "issue",
  }));
}

/**
 * 純関数。クエリの `repo` パラメータ ("owner/repo") を検証し owner / repo に分ける。owner と repo
 * が両方非空で、かつ owner に "/" を含まない (ちょうど1つの "/" 区切り) 形式のみ受け付ける。
 * 不正なら null を返す — 呼び出し側 (ルート) がこれを見て 400 を返す。
 */
export function parseOwnerRepo(input: string): { owner: string; repo: string } | null {
  const slash = input.indexOf("/");
  if (slash <= 0) return null;
  const owner = input.slice(0, slash);
  const repo = input.slice(slash + 1);
  if (!owner || !repo || repo.includes("/")) return null;
  return { owner, repo };
}

export async function listOpenRepoIssues(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubRepoIssue[]> {
  const raw = await fetchAllPages<RawIssue>(
    fetchFn,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=open&per_page=100`,
    token,
    (body) => body as RawIssue[],
  );

  if (raw.length > MAX_ISSUES) {
    console.warn(
      `listOpenRepoIssues: exceeded safety cap of ${MAX_ISSUES} issues for ${owner}/${repo}; truncating`,
    );
    return mapRawIssuesToRepoIssues(raw.slice(0, MAX_ISSUES));
  }

  return mapRawIssuesToRepoIssues(raw);
}
