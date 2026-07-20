import { fetchAllPages, GITHUB_API_BASE } from "./http";

/**
 * リポジトリの open milestone のうち、期日 (due_on) が設定されているものだけを返す
 * (docs/github-integration.md フェーズ①)。カレンダーに置くのは期日そのものなので、
 * due_on の無い milestone は最初から除外する。
 */
export interface OpenMilestone {
  number: number;
  title: string;
  /** ISO 8601 (GitHub の due_on)。呼び出し元 (core/github-items.ts) で epoch ms に変換する。 */
  dueOn: string;
  htmlUrl: string;
}

interface RawMilestone {
  number: number;
  title: string;
  due_on: string | null;
  html_url: string;
}

export async function listOpenMilestones(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
): Promise<OpenMilestone[]> {
  const raw = await fetchAllPages<RawMilestone>(
    fetchFn,
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/milestones?state=open&per_page=100`,
    token,
    (body) => body as RawMilestone[],
  );

  return raw
    .filter((m): m is RawMilestone & { due_on: string } => m.due_on != null)
    .map((m) => ({ number: m.number, title: m.title, dueOn: m.due_on, htmlUrl: m.html_url }));
}
