import type { GitHubWorkItemDTO, GitHubWorkKind } from "@kichijitsu/shared";
import {
  isPullRequestSearchItem,
  ownerRepoFromRepositoryUrl,
  searchIssues,
} from "../github/search";

/**
 * GET /api/github/queue のオーケストレーション (docs/github-integration.md フェーズ②
 * 「作業キュー」)。fetch を注入してテスト可能にする (core/github-items.ts と同じ考え方)。
 */
export interface GitHubQueueDeps {
  fetch: typeof fetch;
  token: string;
}

/**
 * 作業キューを構成する3クエリ。`@me` は GitHub 側で認証ユーザーに解決される。
 * per-repo 列挙ではなく Search API で横断的に取る (docs 参照)。
 */
const QUERIES: { kind: GitHubWorkKind; query: string }[] = [
  { kind: "review_requested", query: "is:open is:pr review-requested:@me" },
  { kind: "assigned", query: "is:open is:issue assignee:@me" },
  { kind: "authored", query: "is:open is:pr author:@me" },
];

/**
 * 3クエリを実行し `GitHubWorkItemDTO[]` にフラット化する。
 *
 * - 同一 (repo, number) が複数クエリにヒットすること (自分が author かつ assignee 等) が
 *   あるが、dedupe せず1アイテムにまとめて `kinds` を配列で持たせる方針 (protocol.ts 参照)。
 * - 1クエリの失敗は握って console.error で継続する (他クエリは出す) —
 *   core/github-items.ts の repo/milestone 単位のエラー処理と同じ考え方。
 * - 切り捨ての警告は github/search.ts 側 (searchIssues) が出す。
 */
export async function fetchGitHubQueue(deps: GitHubQueueDeps): Promise<GitHubWorkItemDTO[]> {
  const byId = new Map<string, GitHubWorkItemDTO>();

  for (const { kind, query } of QUERIES) {
    let result;
    try {
      result = await searchIssues(deps.fetch, deps.token, query);
    } catch (err) {
      console.error(`fetchGitHubQueue: query "${query}" (kind=${kind}) failed`, err);
      continue;
    }

    for (const item of result.items) {
      let repo: string;
      try {
        repo = ownerRepoFromRepositoryUrl(item.repository_url);
      } catch (err) {
        console.error("fetchGitHubQueue: skipping item with unparseable repository_url", err);
        continue;
      }

      const type: "issue" | "pr" = isPullRequestSearchItem(item) ? "pr" : "issue";
      const id = `ghq:${repo}:${type}:${item.number}`;

      const existing = byId.get(id);
      if (existing) {
        if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
        continue;
      }

      byId.set(id, {
        id,
        type,
        kinds: [kind],
        title: item.title,
        repo,
        number: item.number,
        url: item.html_url,
        updatedAt: item.updated_at,
      });
    }
  }

  return Array.from(byId.values());
}
