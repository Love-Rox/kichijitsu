import type { GitHubActivityDTO } from "@kichijitsu/shared";
import { listInstallationRepos } from "../github/installations";
import { listCommits } from "../github/commits";

/**
 * GET /api/github/activity のオーケストレーション (docs/github-integration.md フェーズ③
 * 「実績オーバーレイ」Part A)。fetch を注入してテスト可能にする (core/github-items.ts・
 * core/github-queue.ts と同じ考え方)。
 *
 * 実績の第1弾は自分の commit 活動のみ (`type: 'commit'`)。PR/レビュー活動は将来拡張
 * (GitHubActivityType にバリアントを足すだけで良い形にしてある)。
 */
export interface GitHubActivityDeps {
  fetch: typeof fetch;
  token: string;
  /** commits API の author に渡す GitHub login。 */
  login: string;
  /** ISO 8601。表示中の時間範囲をクライアントから受け取り、そのまま commits API に渡す。 */
  sinceIso: string;
  untilIso: string;
}

/**
 * 合計 commit 数の安全上限。1 repo あたりの上限 (github/commits.ts の
 * MAX_COMMITS_PER_REPO) をくぐり抜けても、インストール先 repo 数が多いと合計は膨らみ得る
 * ため、repo をまたいだ合計にも上限を設ける。上限に達した時点で以降の repo の取得はせず
 * 打ち切る (listInstallationRepos の MAX_REPOS と同じ「上限到達で即 return」流儀)。
 */
const MAX_TOTAL_ACTIVITY = 1000;

/**
 * インストール先 repo を列挙 → 各 repo で `listCommits(author=login)` → GitHubActivityDTO[]
 * にフラット化する。
 *
 * - repo 単位のエラー (listCommits が投げる 404/409 以外の GitHubApiError や network error) は
 *   握って console.error で継続する — core/github-items.ts の repo 単位のエラー処理と同じ
 *   考え方 (1 repo の失敗が全体の取得を止めないようにする)。404/409 自体は listCommits が
 *   空配列として握るのでここには来ない。
 */
export async function fetchGitHubActivity(deps: GitHubActivityDeps): Promise<GitHubActivityDTO[]> {
  const repos = await listInstallationRepos(deps.fetch, deps.token);
  const items: GitHubActivityDTO[] = [];

  for (const { owner, repo } of repos) {
    let commits;
    try {
      commits = await listCommits(
        deps.fetch,
        deps.token,
        owner,
        repo,
        deps.login,
        deps.sinceIso,
        deps.untilIso,
      );
    } catch (err) {
      console.error(`fetchGitHubActivity: failed to list commits for ${owner}/${repo}`, err);
      continue;
    }

    for (const commit of commits) {
      if (items.length >= MAX_TOTAL_ACTIVITY) {
        console.warn(
          `fetchGitHubActivity: exceeded safety cap of ${MAX_TOTAL_ACTIVITY} activity item(s) ` +
            `across repos; truncating`,
        );
        return items;
      }

      items.push({
        id: `gha:${owner}/${repo}:commit:${commit.sha}`,
        type: "commit",
        title: commit.message,
        repo: `${owner}/${repo}`,
        url: commit.htmlUrl,
        timestampMs: Date.parse(commit.timestamp),
      });
    }
  }

  return items;
}
