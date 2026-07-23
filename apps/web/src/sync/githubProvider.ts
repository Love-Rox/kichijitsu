import type {
  GitHubActivityDTO,
  GitHubCiRunDTO,
  GitHubItemDTO,
  GitHubItemType,
  GitHubRepoIssue,
  GitHubRepoIssuesResponse,
  GitHubRepoRef,
  GitHubReposResponse,
  GitHubWorkItemDTO,
  GitHubWorkKind,
} from "@kichijitsu/shared";

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
 * 最初の実証で作業キューだけを gh 化した後、items/activity/ci/pr-commits の4本も同じ
 * 流儀で gh 化した (2026-07-21)。返す DTO は Worker 版と同一なので UI・ストアは無変更で
 * 差し替わる。
 *
 * gh 版と Worker 版の違い:
 *  - **リポジトリ範囲**: Worker 版は GitHub App のインストール先 (`listInstallationRepos`)
 *    に限定するが、`gh api` には installation という概念が無い。代わりに
 *    `GET /user/repos` で認証ユーザーが見えるリポジトリを列挙する (discoverRepos)。
 *    こちらは安全上限 50 件 (MAX_REPOS) で打ち切り、上限ちょうどに達したら
 *    console.warn する — 2回目の呼び出しをしない限り本当の総数が分からないため。
 *  - **ページング**: Worker 版は `Link: rel="next"` ヘッダーを辿るが、`gh_api` (Rust の
 *    Tauri コマンド) は stdout の JSON 文字列しか返さずヘッダーは見えない。代わりに
 *    `page=N` クエリを自前で足しながら `gh_api` を複数回呼び、ページの件数が
 *    `per_page` を下回ったら打ち切る (paginateGhApi)。小さめの page 数上限も設け、
 *    Worker 版の各種 MAX_*_PER_REPO 相当の安全上限を超えたら console.warn して切り捨てる
 *    (数値は同じ精神で選ぶが厳密な一致は求めない)。
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
 * gh のパス上書き(設定画面「gh のパス」、Tauri のみ)の localStorage キー。
 * 空/未設定なら Rust 側 (select_gh_binary) の自動検出にフォールバックする。GUI 起動で PATH に
 * gh が無い環境向けの v0.1.6 自動検出(resolve_gh_path)でも拾えない非標準の場所(nvm/asdf 配下や
 * 独自インストール等)に置いている人向けの手動指定。
 */
const GH_PATH_STORAGE_KEY = "kichijitsu:ghPath";

/** 保存された gh パス上書きを読む(前後空白は除去、未設定は空文字)。 */
export function getGhPathOverride(): string {
  try {
    return window.localStorage.getItem(GH_PATH_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** gh パス上書きを保存する。空文字なら削除して自動検出に戻す。 */
export function setGhPathOverride(path: string): void {
  try {
    const trimmed = path.trim();
    if (trimmed) window.localStorage.setItem(GH_PATH_STORAGE_KEY, trimmed);
    else window.localStorage.removeItem(GH_PATH_STORAGE_KEY);
  } catch {
    /* localStorage 不可(プライベートモード等)は握りつぶす — 上書きが効かないだけ */
  }
}

/**
 * `gh_api` command 呼び出しの共通ラッパー。設定の gh パス上書き(getGhPathOverride)があれば
 * `ghPath`(Tauri v2 が Rust の `gh_path: Option<String>` にマップ)を添えて渡す。空なら付けない
 * (Rust 側の自動検出に委ねる)。旧デスクトップ(gh_path 未対応)では余分な引数は無視されるため安全。
 */
function ghApiInvoke(endpoint: string): Promise<unknown> {
  const ghPath = getGhPathOverride();
  return tauriInvoke("gh_api", ghPath ? { endpoint, ghPath } : { endpoint });
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
      const stdout = (await ghApiInvoke(endpoint)) as string;
      const body = JSON.parse(stdout) as GhSearchResponse;
      results.push({ kind, body });
    } catch (err) {
      console.warn(`kichijitsu: gh_api query (kind=${kind}) failed`, err);
    }
  }

  return mapGhSearchToWorkItems(results);
}

// ---------------------------------------------------------------------------
// items / activity / ci / pr-commits の gh 化 (2026-07-21)。sync 側の対応する
// core/github-*.ts + github/*.ts のマッピング仕様をそのまま踏襲する。
// ---------------------------------------------------------------------------

/** `GET /user/repos` の1件 (必要フィールドのみ)。 */
export interface GhRawRepo {
  name: string;
  owner: { login: string };
}

/** リポジトリ discovery の結果1件。 */
export interface GhRepoRef {
  owner: string;
  repo: string;
}

/**
 * リポジトリ discovery の安全上限。gh には installation 概念が無いため
 * `GET /user/repos` で認証ユーザーが見えるリポジトリを丸ごと列挙する代わりに使う
 * (ファイル先頭のコメント参照)。上限ちょうどに達したら打ち切りの可能性を warn する。
 */
const MAX_REPOS = 50;

/**
 * `gh api user/repos` でリポジトリを列挙する (Worker 版 listInstallationRepos 相当)。
 * ページングはしない (1回の呼び出しで MAX_REPOS 件まで) — 上限ちょうどに達したら
 * 「本当はもっとあるかもしれない」ことだけ warn する。
 */
async function discoverRepos(): Promise<GhRepoRef[]> {
  const stdout = (await ghApiInvoke(
    `user/repos?per_page=${MAX_REPOS}&sort=updated`,
  )) as string;
  const raw = JSON.parse(stdout) as GhRawRepo[];

  if (raw.length >= MAX_REPOS) {
    console.warn(
      `kichijitsu: gh user/repos が上限 ${MAX_REPOS} 件ちょうどを返した。実際にはもっと` +
        `リポジトリがある可能性がある (gh には installation 概念が無いため2回目の呼び出し` +
        `無しに本当の総数は分からない)`,
    );
  }

  return raw.map((r) => ({ owner: r.owner.login, repo: r.name }));
}

/** `gh api user` から認証ユーザーの login を解決する。activity/pr-commits で共用する。 */
async function resolveGhLogin(): Promise<string> {
  const stdout = (await ghApiInvoke("user")) as string;
  const body = JSON.parse(stdout) as { login: string };
  return body.login;
}

const GH_PER_PAGE = 100;

/**
 * `gh api` (Rust の gh_api コマンド、1引数のみ・追加フラグ無し) で `--paginate` が使えない
 * ため、`page=N` クエリを自前で足しながら順に呼んで結果を1配列に集約する共通ヘルパー。
 * ページの件数が `per_page` 未満になったら「もう無い」とみなして打ち切る。`maxPages` は
 * 際限なく叩き続けないための小さな上限 (Worker 側各所の MAX_*_PER_REPO と同じ「有界にする」
 * 精神だが厳密な一致は求めない)。集約後、`cap` を超えていたら切り捨てて console.warn する。
 */
async function paginateGhApi<T>(
  endpointBase: string,
  extractItems: (body: unknown) => T[],
  cap: number,
  maxPages: number,
): Promise<T[]> {
  const results: T[] = [];
  const sep = endpointBase.includes("?") ? "&" : "?";

  for (let page = 1; page <= maxPages; page++) {
    const endpoint = `${endpointBase}${sep}per_page=${GH_PER_PAGE}&page=${page}`;
    const stdout = (await ghApiInvoke(endpoint)) as string;
    const body = JSON.parse(stdout) as unknown;
    const pageItems = extractItems(body);
    results.push(...pageItems);
    if (pageItems.length < GH_PER_PAGE) break;
  }

  if (results.length > cap) {
    console.warn(
      `kichijitsu: gh ページング (${endpointBase}) が安全上限 ${cap} 件を超えた; 切り捨てる`,
    );
    return results.slice(0, cap);
  }

  return results;
}

// --- 1. items -----------------------------------------------------------

/** `/milestones` レスポンスの1件 (sync 側 github/milestones.ts の RawMilestone と同形)。 */
export interface GhRawMilestone {
  number: number;
  title: string;
  due_on: string | null;
  html_url: string;
}

/** `/issues` レスポンスの1件 (sync 側 github/issues.ts の RawIssue と同形)。 */
export interface GhRawIssue {
  number: number;
  title: string;
  html_url: string;
  /** issues エンドポイントでは PR にだけこのフィールドが付く。中身は使わず有無だけ見る。 */
  pull_request?: unknown;
}

/** `/releases` レスポンスの1件 (sync 側 github/releases.ts の RawRelease と同形)。 */
export interface GhRawRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
}

/**
 * 1 repo ぶんの生データ (milestones + milestone 番号ごとの issues + releases) を
 * `GitHubItemDTO[]` に map する **純関数**。sync 側 core/github-items.ts のマッピング
 * ロジックと同等:
 *  - milestone は due_on が無いものを除外し、type='milestone' の DTO を1件push
 *    (id: `gh:{ownerRepo}:milestone:{n}`, dateMs = due_on)。
 *  - 各 (due_on ありの) milestone に属する issue/PR は `pull_request` の有無で type を
 *    判定し、milestone の due_on を dateMs として継承、milestoneTitle も持たせる。
 *  - release は draft または published_at が無いものを除外し、type='release' の DTO を
 *    push (number は常に0、title は name が空文字/nullなら tag_name にフォールバック)。
 */
export function mapGhRepoItemsToDTO(
  ownerRepo: string,
  milestones: GhRawMilestone[],
  issuesByMilestone: Record<number, GhRawIssue[]>,
  releases: GhRawRelease[],
): GitHubItemDTO[] {
  const items: GitHubItemDTO[] = [];

  for (const milestone of milestones) {
    if (milestone.due_on == null) continue;
    const dateMs = Date.parse(milestone.due_on);

    items.push({
      id: `gh:${ownerRepo}:milestone:${milestone.number}`,
      type: "milestone",
      title: milestone.title,
      dateMs,
      repo: ownerRepo,
      number: milestone.number,
      url: milestone.html_url,
    });

    const children = issuesByMilestone[milestone.number] ?? [];
    for (const child of children) {
      const type: GitHubItemType = child.pull_request !== undefined ? "pr" : "issue";
      items.push({
        id: `gh:${ownerRepo}:${type}:${child.number}`,
        type,
        title: child.title,
        dateMs,
        repo: ownerRepo,
        number: child.number,
        url: child.html_url,
        milestoneTitle: milestone.title,
      });
    }
  }

  for (const release of releases) {
    if (release.draft || release.published_at == null) continue;
    items.push({
      id: `gh:${ownerRepo}:release:${release.tag_name}`,
      type: "release",
      title: release.name && release.name.length > 0 ? release.name : release.tag_name,
      dateMs: Date.parse(release.published_at),
      repo: ownerRepo,
      number: 0,
      url: release.html_url,
    });
  }

  return items;
}

/**
 * Tauri 実行時の GitHub アイテム取得。repo discovery → 各 repo の open milestone →
 * (due_on ありの milestone ごとに) open issue/PR → release、と sync 側
 * core/github-items.ts と同じ順で `gh_api` を叩き、`mapGhRepoItemsToDTO` に渡す。
 * repo/milestone 単位の失敗は握って console.warn で継続する (他は出す)。
 */
export async function fetchGitHubItemsViaGh(): Promise<GitHubItemDTO[]> {
  const repos = await discoverRepos();
  const items: GitHubItemDTO[] = [];

  for (const { owner, repo } of repos) {
    const ownerRepo = `${owner}/${repo}`;

    let milestones: GhRawMilestone[];
    try {
      milestones = await paginateGhApi<GhRawMilestone>(
        `repos/${owner}/${repo}/milestones?state=open`,
        (body) => body as GhRawMilestone[],
        200,
        2,
      );
    } catch (err) {
      console.warn(`kichijitsu: gh milestones 取得に失敗 (${ownerRepo})`, err);
      continue;
    }

    const issuesByMilestone: Record<number, GhRawIssue[]> = {};
    for (const milestone of milestones) {
      if (milestone.due_on == null) continue;
      try {
        issuesByMilestone[milestone.number] = await paginateGhApi<GhRawIssue>(
          `repos/${owner}/${repo}/issues?milestone=${milestone.number}&state=open`,
          (body) => body as GhRawIssue[],
          200,
          2,
        );
      } catch (err) {
        console.warn(
          `kichijitsu: gh issues 取得に失敗 (${ownerRepo}#milestone${milestone.number})`,
          err,
        );
      }
    }

    let releases: GhRawRelease[];
    try {
      releases = await paginateGhApi<GhRawRelease>(
        `repos/${owner}/${repo}/releases`,
        (body) => body as GhRawRelease[],
        100,
        1,
      );
    } catch (err) {
      console.warn(`kichijitsu: gh releases 取得に失敗 (${ownerRepo})`, err);
      releases = [];
    }

    items.push(...mapGhRepoItemsToDTO(ownerRepo, milestones, issuesByMilestone, releases));
  }

  return items;
}

// --- 2. activity ----------------------------------------------------------

/** `/commits` レスポンスの1件 (sync 側 github/commits.ts の RawCommit と同形)。 */
export interface GhRawCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { date?: string };
    committer?: { date?: string };
  };
}

/**
 * 1 repo ぶんの commit を `GitHubActivityDTO[]` に map する **純関数**。sync 側
 * github/commits.ts + core/github-activity.ts のマッピングロジックと同等:
 *  - id: `gha:{ownerRepo}:commit:{sha}`
 *  - title: commit message の先頭行のみ
 *  - timestampMs: commit.author.date、無ければ commit.committer.date
 */
export function mapGhCommitsToActivity(
  ownerRepo: string,
  commits: GhRawCommit[],
): GitHubActivityDTO[] {
  return commits.map((c) => ({
    id: `gha:${ownerRepo}:commit:${c.sha}`,
    type: "commit",
    title: c.commit.message.split("\n")[0],
    repo: ownerRepo,
    url: c.html_url,
    timestampMs: Date.parse(c.commit.author?.date ?? c.commit.committer?.date ?? ""),
  }));
}

/** 合計 activity 数の安全上限 (sync 側 core/github-activity.ts の MAX_TOTAL_ACTIVITY と同値)。 */
const MAX_TOTAL_ACTIVITY = 1000;

/** 1 repo あたりの安全上限 (sync 側 github/commits.ts の MAX_COMMITS_PER_REPO と同値)。 */
const MAX_COMMITS_PER_REPO = 300;

/**
 * Tauri 実行時の GitHub 実績オーバーレイ取得。login を解決 → repo discovery → 各 repo で
 * `author=login&since=&until=` の commits を取得し `mapGhCommitsToActivity` に渡す。
 * repo 単位の失敗は握って console.warn で継続する。合計件数が MAX_TOTAL_ACTIVITY に
 * 達したら以降の repo は処理せず打ち切る (sync 側 core/github-activity.ts と同じ流儀)。
 */
export async function fetchGitHubActivityViaGh(
  sinceIso: string,
  untilIso: string,
): Promise<GitHubActivityDTO[]> {
  const login = await resolveGhLogin();
  const repos = await discoverRepos();
  const items: GitHubActivityDTO[] = [];

  for (const { owner, repo } of repos) {
    const ownerRepo = `${owner}/${repo}`;

    let commits: GhRawCommit[];
    try {
      const params = new URLSearchParams({ author: login, since: sinceIso, until: untilIso });
      commits = await paginateGhApi<GhRawCommit>(
        `repos/${owner}/${repo}/commits?${params.toString()}`,
        (body) => body as GhRawCommit[],
        MAX_COMMITS_PER_REPO,
        3,
      );
    } catch (err) {
      console.warn(`kichijitsu: gh commits 取得に失敗 (${ownerRepo})`, err);
      continue;
    }

    for (const activity of mapGhCommitsToActivity(ownerRepo, commits)) {
      if (items.length >= MAX_TOTAL_ACTIVITY) {
        console.warn(
          `kichijitsu: gh activity が安全上限 ${MAX_TOTAL_ACTIVITY} 件を超えた; 切り捨てる`,
        );
        return items;
      }
      items.push(activity);
    }
  }

  return items;
}

// --- 3. CI ------------------------------------------------------------

/** `/actions/runs` レスポンスの1件 (sync 側 github/workflow-runs.ts の RawWorkflowRun と同形)。 */
export interface GhRawWorkflowRun {
  id: number;
  name: string | null;
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

/** `/actions/runs` のレスポンス body (`workflow_runs` 配列でラップされている)。 */
export interface GhWorkflowRunsResponseBody {
  total_count: number;
  workflow_runs: GhRawWorkflowRun[];
}

/**
 * 1 repo ぶんの workflow run を `GitHubCiRunDTO[]` に map する **純関数**。sync 側
 * github/workflow-runs.ts + core/github-ci.ts のマッピングロジックと同等:
 *  - id: `gci:{ownerRepo}:{runId}`
 *  - name: null なら空文字にフォールバック
 *  - status/conclusion: GitHub の生文字列をそのまま
 *  - timestampMs: created_at
 */
export function mapGhWorkflowRunsToCi(
  ownerRepo: string,
  runs: GhRawWorkflowRun[],
): GitHubCiRunDTO[] {
  return runs.map((r) => ({
    id: `gci:${ownerRepo}:${r.id}`,
    repo: ownerRepo,
    name: r.name ?? "",
    url: r.html_url,
    status: r.status,
    conclusion: r.conclusion,
    timestampMs: Date.parse(r.created_at),
  }));
}

/** 合計 run 数の安全上限 (sync 側 core/github-ci.ts の MAX_TOTAL_CI_RUNS と同値)。 */
const MAX_TOTAL_CI_RUNS = 1000;

/** 1 repo あたりの安全上限 (sync 側 github/workflow-runs.ts の MAX_RUNS_PER_REPO と同値)。 */
const MAX_RUNS_PER_REPO = 200;

/**
 * Tauri 実行時の CI/Actions 実行取得。repo discovery (login 解決は不要 — CI は誰の push の
 * 実行でも見えてよい、sync 側 core/github-ci.ts のコメント参照) → 各 repo で
 * `created={since}..{until}` の workflow runs を取得し `mapGhWorkflowRunsToCi` に渡す。
 * repo 単位の失敗は握って console.warn で継続する。合計件数が MAX_TOTAL_CI_RUNS に
 * 達したら以降の repo は処理せず打ち切る。
 */
export async function fetchGitHubCiRunsViaGh(
  sinceIso: string,
  untilIso: string,
): Promise<GitHubCiRunDTO[]> {
  const repos = await discoverRepos();
  const items: GitHubCiRunDTO[] = [];

  for (const { owner, repo } of repos) {
    const ownerRepo = `${owner}/${repo}`;

    let runs: GhRawWorkflowRun[];
    try {
      const params = new URLSearchParams({ created: `${sinceIso}..${untilIso}` });
      runs = await paginateGhApi<GhRawWorkflowRun>(
        `repos/${owner}/${repo}/actions/runs?${params.toString()}`,
        (body) => (body as GhWorkflowRunsResponseBody).workflow_runs ?? [],
        MAX_RUNS_PER_REPO,
        2,
      );
    } catch (err) {
      console.warn(`kichijitsu: gh workflow runs 取得に失敗 (${ownerRepo})`, err);
      continue;
    }

    for (const run of mapGhWorkflowRunsToCi(ownerRepo, runs)) {
      if (items.length >= MAX_TOTAL_CI_RUNS) {
        console.warn(
          `kichijitsu: gh CI runs が安全上限 ${MAX_TOTAL_CI_RUNS} 件を超えた; 切り捨てる`,
        );
        return items;
      }
      items.push(run);
    }
  }

  return items;
}

// --- 4. PR commits ----------------------------------------------------

/** `/pulls/{number}/commits` レスポンスの1件 (sync 側 github/pull-commits.ts の RawPullCommit と同形)。 */
export interface GhRawPullCommit {
  sha: string;
  commit: {
    author?: { date?: string };
    committer?: { date?: string };
  };
  /** トップレベルの author は GitHub ユーザーオブジェクト。フォーク由来などで null になり得る。 */
  author: { login: string } | null;
}

/**
 * 1 PR ぶんの commit を、自分 (authorLogin) がコミットしたものの時刻だけの昇順配列に map する
 * **純関数**。sync 側 github/pull-commits.ts のマッピングロジックと同等:
 *  - author が null、または author.login !== authorLogin の commit は除外する。
 *  - タイムスタンプは commit.author.date、無ければ commit.committer.date。どちらも無ければ
 *    その commit をスキップする。
 *  - 昇順にソートして返す。
 */
export function mapGhPullCommitsToTimestamps(
  commits: GhRawPullCommit[],
  authorLogin: string,
): string[] {
  const timestamps: string[] = [];

  for (const c of commits) {
    if (c.author === null || c.author.login !== authorLogin) continue;
    const timestamp = c.commit.author?.date ?? c.commit.committer?.date;
    if (!timestamp) continue;
    timestamps.push(timestamp);
  }

  timestamps.sort((a, b) => Date.parse(a) - Date.parse(b));
  return timestamps;
}

/** リクエストで受け取る PR の最大件数 (sync 側 core/github-pr-commits.ts の MAX_ITEMS と同値)。 */
const MAX_ITEMS = 50;

/** 1 PR あたりの安全上限 (sync 側 github/pull-commits.ts の MAX_COMMITS_PER_PR と同値)。 */
const MAX_COMMITS_PER_PR = 250;

/**
 * Tauri 実行時の PR commit 取得。login を解決 (activity と共通の resolveGhLogin) →
 * 各 { repo, number } について `repos/{o}/{r}/pulls/{n}/commits` を取得し
 * `mapGhPullCommitsToTimestamps` に渡す。sync 側 core/github-pr-commits.ts と同じ流儀:
 *  - items が MAX_ITEMS を超えたら console.warn した上で先頭 MAX_ITEMS 件だけ処理する。
 *  - repo 文字列に "/" が無いものは console.error してスキップする。
 *  - 1 件の失敗は握って console.error で継続し、その際は結果の Record に該当キーを含めない。
 */
export async function fetchPullCommitsViaGh(
  items: { repo: string; number: number }[],
): Promise<Record<string, string[]>> {
  let targets = items;
  if (targets.length > MAX_ITEMS) {
    console.warn(
      `kichijitsu: gh pr-commits が ${targets.length} 件受け取り、安全上限 ${MAX_ITEMS} 件を` +
        `超えたため切り捨てる`,
    );
    targets = targets.slice(0, MAX_ITEMS);
  }

  const login = await resolveGhLogin();
  const commitsByItem: Record<string, string[]> = {};

  for (const item of targets) {
    const slashIndex = item.repo.indexOf("/");
    if (slashIndex === -1) {
      console.error(`kichijitsu: 不正な repo "${item.repo}" ("owner/repo" 形式が必要)`);
      continue;
    }
    const owner = item.repo.slice(0, slashIndex);
    const repo = item.repo.slice(slashIndex + 1);

    try {
      const commits = await paginateGhApi<GhRawPullCommit>(
        `repos/${owner}/${repo}/pulls/${item.number}/commits`,
        (body) => body as GhRawPullCommit[],
        MAX_COMMITS_PER_PR,
        3,
      );
      commitsByItem[`${item.repo}#${item.number}`] = mapGhPullCommitsToTimestamps(commits, login);
    } catch (err) {
      console.error(`kichijitsu: gh PR commits 取得に失敗 (${item.repo}#${item.number})`, err);
    }
  }

  return commitsByItem;
}

// ---------------------------------------------------------------------------
// 5. repos / repo-issues の取得 (実績 UX 刷新フェーズ3「手動追加フォームのプルダウン化」、
// 2026-07-23)。WorkLogModal の org/repo/issue カスケードプルダウンの元データ。他の GitHub 取得と
// 同じ isTauri() 分岐で gh 経路 / サーバー経路を出し分ける統一 API (fetchRepos / fetchRepoIssues)
// を提供する。サーバー経路は cookie 認証の checkedFetch を呼び出し側 (App/モーダル) から渡してもらう
// (fetchGithubQueue と同じ考え方だが、gh 版の他関数と違いサーバー fetch もこの関数内で行う)。
// ---------------------------------------------------------------------------

/** App.tsx の checkedFetch (オフライン判定を挟む fetch ラッパー) の型。 */
export type CheckedFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * gh 経路の repo 一覧取得。既存の discoverRepos (`gh api user/repos`) をそのまま再利用する
 * (返す {owner, repo}[] が GitHubRepoRef と同形)。
 */
export function fetchReposViaGh(): Promise<GitHubRepoRef[]> {
  return discoverRepos();
}

/** repo-issues の gh ページング安全上限 (issue の多い repo でも有界にする)。 */
const MAX_REPO_ISSUES = 200;
const MAX_REPO_ISSUES_PAGES = 2;

/**
 * 純関数。`gh api repos/{o}/{r}/issues?state=open` の生レスポンス配列を GitHubRepoIssue[] に map
 * する。issues エンドポイントは PR も含む — `pull_request` の有無で type を 'pr' / 'issue' に分ける
 * (sync 側 github/repo-issues.ts の mapRawIssuesToRepoIssues と同等)。
 */
export function mapGhRepoIssuesToDTO(raw: GhRawIssue[]): GitHubRepoIssue[] {
  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    type: issue.pull_request !== undefined ? "pr" : "issue",
  }));
}

/**
 * gh 経路の repo-issues 取得。`repos/{o}/{r}/issues?state=open` を叩き、`pull_request` の有無で
 * type を判定して GitHubRepoIssue[] に map する。repo は "owner/repo" 形式 (先頭の "/" で分割)。
 */
export async function fetchRepoIssuesViaGh(repo: string): Promise<GitHubRepoIssue[]> {
  const slash = repo.indexOf("/");
  if (slash <= 0) {
    throw new Error(`fetchRepoIssuesViaGh: 不正な repo "${repo}" ("owner/repo" 形式が必要)`);
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);

  const raw = await paginateGhApi<GhRawIssue>(
    `repos/${owner}/${name}/issues?state=open`,
    (body) => body as GhRawIssue[],
    MAX_REPO_ISSUES,
    MAX_REPO_ISSUES_PAGES,
  );
  return mapGhRepoIssuesToDTO(raw);
}

/** サーバー経路の repo 一覧取得 (GET /api/github/repos)。非 2xx は Error を投げる。 */
async function fetchReposViaServer(checkedFetch: CheckedFetch): Promise<GitHubRepoRef[]> {
  const res = await checkedFetch("/api/github/repos");
  if (!res.ok) {
    throw new Error(`GET /api/github/repos failed: ${res.status}`);
  }
  const data = (await res.json()) as GitHubReposResponse;
  return data.repos;
}

/** サーバー経路の repo-issues 取得 (GET /api/github/repo-issues?repo=)。非 2xx は Error を投げる。 */
async function fetchRepoIssuesViaServer(
  repo: string,
  checkedFetch: CheckedFetch,
): Promise<GitHubRepoIssue[]> {
  const res = await checkedFetch(`/api/github/repo-issues?repo=${encodeURIComponent(repo)}`);
  if (!res.ok) {
    throw new Error(`GET /api/github/repo-issues failed: ${res.status}`);
  }
  const data = (await res.json()) as GitHubRepoIssuesResponse;
  return data.issues;
}

/**
 * 統一 API: repo 一覧を取得する。Tauri デスクトップでは手元の gh CLI 認証で直接取得し、
 * ブラウザ/PWA では checkedFetch 経由で GET /api/github/repos を叩く (fetchGithubQueue と同じ流儀)。
 * 失敗は呼び出し側 (WorkLogModal) が握って手入力フォールバックへ切り替える。
 */
export function fetchRepos(checkedFetch: CheckedFetch): Promise<GitHubRepoRef[]> {
  return isTauri() ? fetchReposViaGh() : fetchReposViaServer(checkedFetch);
}

/**
 * 統一 API: 指定 repo ("owner/repo") の open issue/PR を取得する。isTauri() で gh 経路 /
 * サーバー経路を出し分ける (fetchRepos と同じ)。失敗は呼び出し側が握る。
 */
export function fetchRepoIssues(
  repo: string,
  checkedFetch: CheckedFetch,
): Promise<GitHubRepoIssue[]> {
  return isTauri() ? fetchRepoIssuesViaGh(repo) : fetchRepoIssuesViaServer(repo, checkedFetch);
}
