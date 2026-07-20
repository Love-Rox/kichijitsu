import type { GitHubCiRunDTO } from "@kichijitsu/shared";
import { listInstallationRepos } from "../github/installations";
import { listWorkflowRuns } from "../github/workflow-runs";

/**
 * GET /api/github/ci のオーケストレーション (docs/github-integration.md フェーズ④b「CI/Actions
 * 実行をタイムラインに薄く重ねる」)。core/github-activity.ts (フェーズ③実績オーバーレイ) を
 * 鏡にした実装だが、③ と違い自分がトリガーした分に限定しない (誰の push の CI 実行でも
 * 見えてよい — 作業実績ではなくリポジトリの健全性シグナルという位置づけのため。将来
 * actor 絞りを足す場合は listWorkflowRuns の呼び出し側にフィルタを足すだけで良い形にしてある)。
 * fetch を注入してテスト可能にする (core/github-activity.ts と同じ考え方)。
 */
export interface GitHubCiDeps {
  fetch: typeof fetch;
  token: string;
}

/**
 * 合計 run 数の安全上限。1 repo あたりの上限 (github/workflow-runs.ts の
 * MAX_RUNS_PER_REPO) をくぐり抜けても、インストール先 repo 数が多いと合計は膨らみ得るため、
 * repo をまたいだ合計にも上限を設ける (core/github-activity.ts の MAX_TOTAL_ACTIVITY と同じ考え方)。
 */
const MAX_TOTAL_CI_RUNS = 1000;

/**
 * インストール先 repo を列挙 → 各 repo で `listWorkflowRuns` → GitHubCiRunDTO[] にフラット化する。
 *
 * - repo 単位のエラー (listWorkflowRuns が投げる 404 以外の GitHubApiError や network error) は
 *   握って console.error で継続する (core/github-activity.ts と同じ考え方)。404 自体は
 *   listWorkflowRuns が空配列として握るのでここには来ない。
 */
export async function fetchGitHubCiRuns(
  deps: GitHubCiDeps,
  sinceIso: string,
  untilIso: string,
): Promise<GitHubCiRunDTO[]> {
  const repos = await listInstallationRepos(deps.fetch, deps.token);
  const items: GitHubCiRunDTO[] = [];

  for (const { owner, repo } of repos) {
    let runs;
    try {
      runs = await listWorkflowRuns(deps.fetch, deps.token, owner, repo, sinceIso, untilIso);
    } catch (err) {
      console.error(`fetchGitHubCiRuns: failed to list workflow runs for ${owner}/${repo}`, err);
      continue;
    }

    for (const run of runs) {
      if (items.length >= MAX_TOTAL_CI_RUNS) {
        console.warn(
          `fetchGitHubCiRuns: exceeded safety cap of ${MAX_TOTAL_CI_RUNS} run(s) across repos; truncating`,
        );
        return items;
      }

      items.push({
        id: `gci:${owner}/${repo}:${run.id}`,
        repo: `${owner}/${repo}`,
        name: run.name,
        url: run.htmlUrl,
        status: run.status,
        conclusion: run.conclusion,
        timestampMs: Date.parse(run.createdAt),
      });
    }
  }

  return items;
}
