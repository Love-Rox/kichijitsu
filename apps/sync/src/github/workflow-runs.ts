import { fetchAllPages, GITHUB_API_BASE, GitHubApiError } from "./http";

/**
 * 指定 repo の Actions workflow run 一覧 (docs/github-integration.md フェーズ④b「CI/Actions
 * 実行をタイムラインに薄く重ねる」)。github/commits.ts (フェーズ③実績オーバーレイ Part A) を
 * 鏡にした実装 — commits の `author`+`since`/`until` の代わりに、workflow runs API の
 * `created` フィルタ (`YYYY-MM-DD..YYYY-MM-DD` または ISO 日時レンジ構文) で範囲限定する。
 * ③ と違い自分がトリガーした分に限定しない (CI は誰の push でも見えてよい、将来 actor 絞りは拡張)。
 */
export interface WorkflowRunInfo {
  id: number;
  /** workflow 名。GitHub 側で null になり得るため空文字にフォールバックする。 */
  name: string;
  htmlUrl: string;
  /** GitHub の生文字列 (queued/in_progress/completed) をそのまま持つ。 */
  status: string;
  /** GitHub の生文字列 (success/failure/... ) または未完了なら null。 */
  conclusion: string | null;
  /** ISO 8601 (created_at)。 */
  createdAt: string;
}

interface RawWorkflowRun {
  id: number;
  name: string | null;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

interface WorkflowRunsResponseBody {
  total_count: number;
  workflow_runs: RawWorkflowRun[];
}

/**
 * 1 repo あたりの安全上限 (github/commits.ts の MAX_COMMITS_PER_REPO と同じ考え方)。
 * created レンジで有界にしていても、対象 repo が非常に活発だとページが際限なく続き得るため
 * 取得後に打ち切る。
 */
const MAX_RUNS_PER_REPO = 200;

/**
 * `GET /repos/{owner}/{repo}/actions/runs?created={since}..{until}`。
 *
 * - 404 (repo が見えない、または Actions が無効) は例外にせず空配列で握る — 呼び出し元
 *   (core/github-ci.ts) が該当 repo をスキップできるようにするため (github/commits.ts の
 *   404/409 の握り方と同じ考え方。workflow runs API に commits API の 409 相当 (空リポジトリ)
 *   は無いので 404 のみ)。
 * - それ以外の非 2xx は GitHubApiError のまま伝播させる (401 は呼び出し元でトークン失効判定に使う)。
 */
export async function listWorkflowRuns(
  fetchFn: typeof fetch,
  token: string,
  owner: string,
  repo: string,
  sinceIso: string,
  untilIso: string,
): Promise<WorkflowRunInfo[]> {
  const params = new URLSearchParams({
    created: `${sinceIso}..${untilIso}`,
    per_page: "100",
  });
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs?${params.toString()}`;

  let raw: RawWorkflowRun[];
  try {
    raw = await fetchAllPages<RawWorkflowRun>(
      fetchFn,
      url,
      token,
      (body) => (body as WorkflowRunsResponseBody).workflow_runs ?? [],
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return [];
    }
    throw err;
  }

  if (raw.length > MAX_RUNS_PER_REPO) {
    console.warn(
      `listWorkflowRuns: ${owner}/${repo} returned ${raw.length} run(s), exceeding the safety cap ` +
        `of ${MAX_RUNS_PER_REPO} for the range ${sinceIso}..${untilIso}; truncating`,
    );
    raw = raw.slice(0, MAX_RUNS_PER_REPO);
  }

  return raw.map((r) => ({
    id: r.id,
    name: r.name ?? "",
    htmlUrl: r.html_url,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
  }));
}
