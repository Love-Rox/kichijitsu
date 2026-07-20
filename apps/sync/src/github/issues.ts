import { fetchAllPages, GITHUB_API_BASE } from "./http";

/**
 * 指定 milestone に属する open issue/PR (docs/github-integration.md フェーズ①)。
 * GitHub の `issues` エンドポイントは PR も含む — `pull_request` フィールドの有無で
 * type を 'issue' / 'pr' に分ける (無ければ issue、あれば pr)。
 */
export interface MilestoneIssueItem {
  number: number;
  title: string;
  htmlUrl: string;
  type: "issue" | "pr";
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  /** issues エンドポイントでは PR にだけこのフィールドが付く。中身は使わず有無だけ見る。 */
  pull_request?: unknown;
}

export async function listOpenIssuesForMilestone(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  milestoneNumber: number,
): Promise<MilestoneIssueItem[]> {
  const raw = await fetchAllPages<RawIssue>(
    fetchFn,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?milestone=${milestoneNumber}&state=open&per_page=100`,
    token,
    (body) => body as RawIssue[],
  );

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    htmlUrl: issue.html_url,
    type: issue.pull_request ? "pr" : "issue",
  }));
}
