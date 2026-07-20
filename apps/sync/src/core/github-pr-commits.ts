import { listPullCommitTimestamps } from "../github/pull-commits";

/**
 * POST /api/github/pr-commits のオーケストレーション (docs/github-integration.md
 * フェーズ③「時間計測」Part A)。fetch を注入してテスト可能にする (core/github-activity.ts と
 * 同じ考え方)。
 */
export interface GitHubPrCommitsDeps {
  fetch: typeof fetch;
  token: string;
  login: string;
}

/**
 * リクエストで受け取る PR の最大件数。1リクエストで膨大な PR を渡されると repo/number ごとに
 * 直列で GitHub API を叩くことになり時間がかかりすぎるため、超過分は打ち切る
 * (core/github-activity.ts の MAX_TOTAL_ACTIVITY と同じ「上限超過は warn して切る」流儀)。
 */
const MAX_ITEMS = 50;

/**
 * 各 { repo: "owner/repo", number } について `listPullCommitTimestamps(author=login)` を呼び、
 * `"{repo}#{number}"` をキーにした Record にまとめる。
 *
 * - items が MAX_ITEMS を超えたら console.warn した上で先頭 MAX_ITEMS 件だけ処理する。
 * - repo 文字列に "/" が無いものは owner/repo に分解できないので console.error してスキップする。
 * - 1 件の失敗 (listPullCommitTimestamps が投げる非 404 の GitHubApiError や network error) は
 *   握って console.error で継続する (core/github-activity.ts の repo 単位のエラー処理と同じ
 *   考え方) — その際は結果の Record に該当キーを含めない (空配列も入れない)。
 */
export async function fetchPullCommitsForItems(
  deps: GitHubPrCommitsDeps,
  items: { repo: string; number: number }[],
): Promise<Record<string, string[]>> {
  let targets = items;
  if (targets.length > MAX_ITEMS) {
    console.warn(
      `fetchPullCommitsForItems: received ${targets.length} item(s), exceeding the safety cap ` +
        `of ${MAX_ITEMS}; truncating`,
    );
    targets = targets.slice(0, MAX_ITEMS);
  }

  const commitsByItem: Record<string, string[]> = {};

  for (const item of targets) {
    const slashIndex = item.repo.indexOf("/");
    if (slashIndex === -1) {
      console.error(
        `fetchPullCommitsForItems: invalid repo "${item.repo}" (expected "owner/repo")`,
      );
      continue;
    }
    const owner = item.repo.slice(0, slashIndex);
    const repo = item.repo.slice(slashIndex + 1);

    try {
      const timestamps = await listPullCommitTimestamps(
        deps.fetch,
        deps.token,
        owner,
        repo,
        item.number,
        deps.login,
      );
      commitsByItem[`${item.repo}#${item.number}`] = timestamps;
    } catch (err) {
      console.error(
        `fetchPullCommitsForItems: failed to list commits for ${item.repo}#${item.number}`,
        err,
      );
    }
  }

  return commitsByItem;
}
