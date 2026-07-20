import type { GitHubWorkItemDTO, GitHubWorkKind } from "@kichijitsu/shared";

/**
 * GitHub 取得の「プロバイダ」抽象の web 側実装 (docs/github-integration.md
 * 「認証プロバイダの抽象化」)。
 *
 * リモート URL の web アプリは2系統のプロバイダを分岐で使い分ける:
 *  - **Worker OAuth** (ブラウザ/PWA、従来): `GET /api/github/queue` を叩く (App.tsx)。
 *  - **ローカル gh** (Tauri デスクトップ): `window.__TAURI__` 経由で Rust の `gh_api`
 *    コマンドを invoke し、手元の `gh auth login` 済み認証で GitHub REST を直接叩く。
 *    Worker も OAuth トークンも不要 — 認証が取りづらい org 対策 (ユーザー要望)。
 *
 * 今回の薄い実証では **作業キューだけ** を gh 化する。items/activity/ci/pr-commits は
 * 従来どおり Worker 経由のまま (次増分の TODO)。返す DTO は Worker 版と同一なので UI・
 * ストアは無変更で差し替わる。
 */

/**
 * Tauri の webview で動いているかの判定。tauri.conf.json の app.withGlobalTauri=true で
 * webview に注入される `window.__TAURI__` の有無で見る。ブラウザ/PWA では常に false に
 * なるため、従来のブラウザ挙動は一切変わらない。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/**
 * `window.__TAURI__.core.invoke` の最小型 (公式の型パッケージを入れず局所宣言に留める)。
 */
interface TauriGlobal {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function tauriInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri) throw new Error("isTauri() が false の環境で tauriInvoke が呼ばれた");
  return tauri.core.invoke(cmd, args);
}

/**
 * 作業キューを構成する3クエリ (sync 側 core/github-queue.ts と同一。`@me` は gh が
 * 認証ユーザーに解決する)。gh の endpoint は `gh api <endpoint>` の第1引数。
 */
const WORK_QUEUE_ENDPOINTS: { kind: GitHubWorkKind; endpoint: string }[] = [
  {
    kind: "review_requested",
    endpoint: "search/issues?q=is:open is:pr review-requested:@me&per_page=50",
  },
  { kind: "assigned", endpoint: "search/issues?q=is:open is:issue assignee:@me&per_page=50" },
  { kind: "authored", endpoint: "search/issues?q=is:open is:pr author:@me&per_page=50" },
];

/** `/search/issues` レスポンス item (必要フィールドのみ、sync 側 GitHubSearchItem と同形)。 */
export interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  /** PR にだけ付く。有無だけ見る。 */
  pull_request?: unknown;
  /** 例: `https://api.github.com/repos/owner/repo` */
  repository_url: string;
  updated_at: string;
}

export interface GhSearchResponse {
  items?: GhSearchItem[];
}

/** 1クエリぶんの結果 (kind + search レスポンス body)。 */
export interface GhWorkQueryResult {
  kind: GitHubWorkKind;
  body: GhSearchResponse;
}

/**
 * `repository_url` (`https://api.github.com/repos/owner/repo`) から `owner/repo` を導出。
 * 想定外の形式なら null (呼び出し元がスキップ)。sync 側 ownerRepoFromRepositoryUrl 相当。
 */
function ownerRepoFromRepositoryUrl(repositoryUrl: string): string | null {
  const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

/**
 * gh の search レスポンス群 → `GitHubWorkItemDTO[]` への **純関数** マッピング。
 * sync 側 fetchGitHubQueue のマッピングロジックと同等 (web からは sync を import できない
 * ため web 側に新設):
 *  - id = `ghq:{owner}/{repo}:{issue|pr}:{number}`
 *  - `pull_request` の有無で type を判定
 *  - 同一 (repo, number) は dedupe せず1アイテムにまとめ kinds を配列でマージ (重複なし)
 *  - repository_url が壊れている item はスキップ
 */
export function mapGhSearchToWorkItems(results: GhWorkQueryResult[]): GitHubWorkItemDTO[] {
  const byId = new Map<string, GitHubWorkItemDTO>();

  for (const { kind, body } of results) {
    for (const item of body.items ?? []) {
      const repo = ownerRepoFromRepositoryUrl(item.repository_url);
      if (!repo) continue;

      const type: "issue" | "pr" = item.pull_request !== undefined ? "pr" : "issue";
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

/**
 * Tauri 実行時の作業キュー取得。3クエリを `gh api` (Rust の gh_api コマンド) で叩き、
 * 生 JSON を map する。1クエリの失敗は握って warn で継続する (他クエリは出す —
 * sync 側と同じ考え方)。`gh` 未インストール/未ログインは gh_api が Err を返す。
 */
export async function fetchWorkQueueViaGh(): Promise<GitHubWorkItemDTO[]> {
  const results: GhWorkQueryResult[] = [];

  for (const { kind, endpoint } of WORK_QUEUE_ENDPOINTS) {
    try {
      const stdout = (await tauriInvoke("gh_api", { endpoint })) as string;
      const body = JSON.parse(stdout) as GhSearchResponse;
      results.push({ kind, body });
    } catch (err) {
      console.warn(`kichijitsu: gh_api query (kind=${kind}) failed`, err);
    }
  }

  return mapGhSearchToWorkItems(results);
}
