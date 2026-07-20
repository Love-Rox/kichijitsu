import type { GitHubItemDTO } from "@kichijitsu/shared";
import { listInstallationRepos } from "../github/installations";
import { listOpenMilestones } from "../github/milestones";
import { listOpenIssuesForMilestone } from "../github/issues";

/**
 * GET /api/github/items のオーケストレーション (docs/github-integration.md フェーズ①)。
 * fetch を注入してテスト可能にする (google 側の TasksCoreDeps などと同じ考え方)。
 */
export interface GitHubItemsDeps {
  fetch: typeof fetch;
  token: string;
}

/**
 * インストール先 repo を列挙 → 各 repo の open milestone (due_on あり) → 各 milestone の
 * open issue/PR を取得し、GitHubItemDTO[] にフラットに map する。
 *
 * - milestone 自体も1アイテムとして含める (type='milestone', dateMs=due_on)。
 * - issue/PR は所属 milestone の due_on を dateMs に採用する (GitHub の issue/PR 自体には
 *   締切概念が無いため、milestone の期日を継承する) — milestoneTitle も持たせる。
 * - repo/milestone 単位のエラーは握って console.error で継続する: 1 repo (または1
 *   milestone) の失敗が全体の取得を止めないようにする。
 *
 * TODO: レート制限節約の ETag 対応は次フェーズ (Part B 後) でやる。
 */
export async function fetchGitHubItems(deps: GitHubItemsDeps): Promise<GitHubItemDTO[]> {
  const repos = await listInstallationRepos(deps.fetch, deps.token);
  const items: GitHubItemDTO[] = [];

  for (const { owner, repo } of repos) {
    let milestones;
    try {
      milestones = await listOpenMilestones(deps.fetch, deps.token, owner, repo);
    } catch (err) {
      console.error(`fetchGitHubItems: failed to list milestones for ${owner}/${repo}`, err);
      continue;
    }

    for (const milestone of milestones) {
      const dateMs = Date.parse(milestone.dueOn);

      items.push({
        id: `gh:${owner}/${repo}:milestone:${milestone.number}`,
        type: "milestone",
        title: milestone.title,
        dateMs,
        repo: `${owner}/${repo}`,
        number: milestone.number,
        url: milestone.htmlUrl,
      });

      let children;
      try {
        children = await listOpenIssuesForMilestone(
          deps.fetch,
          deps.token,
          owner,
          repo,
          milestone.number,
        );
      } catch (err) {
        console.error(
          `fetchGitHubItems: failed to list issues for milestone ${owner}/${repo}#${milestone.number}`,
          err,
        );
        continue;
      }

      for (const child of children) {
        items.push({
          id: `gh:${owner}/${repo}:${child.type}:${child.number}`,
          type: child.type,
          title: child.title,
          dateMs,
          repo: `${owner}/${repo}`,
          number: child.number,
          url: child.htmlUrl,
          milestoneTitle: milestone.title,
        });
      }
    }
  }

  return items;
}
