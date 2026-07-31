/**
 * GitHub 連携の `/api/github*` ルート (docs/github-integration.md / docs/github-oauth.md)。
 * routes/api.ts から分割 (2026-07-25) — 挙動は変えていない。
 *
 * どのルートも「GitHub を叩いて DTO を返すだけ、サーバーは永続化しない」(Google の /api/sync と
 * 同じ思想)。トークン解決とエラーマッピングは共通なので、resolveGitHubAccessToken と
 * withGitHubToken (このファイル末尾) に1本化してある。
 */
import { Hono, type Context } from "hono";
import type {
  ApiError,
  GitHubActivityResponse,
  GitHubCiRunsResponse,
  GitHubItemsResponse,
  GitHubQueueResponse,
  GitHubReposResponse,
  GitHubRepoIssuesResponse,
  PullCommitsRequest,
  PullCommitsResponse,
} from "@kichijitsu/shared";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware";
import { INVALID_JSON, readJsonBody } from "./guards";
import { decryptToken, InvalidCiphertextError } from "../crypto";
import { fetchGitHubActivity } from "../core/github-activity";
import { fetchGitHubCiRuns } from "../core/github-ci";
import { fetchGitHubItems } from "../core/github-items";
import { fetchGitHubQueue } from "../core/github-queue";
import { fetchPullCommitsForItems } from "../core/github-pr-commits";
import { listInstallationRepos } from "../github/installations";
import { listOpenRepoIssues, parseOwnerRepo } from "../github/repo-issues";
import { GitHubApiError } from "../github/http";

export const githubRoutes = new Hono<AppEnv>();

// GitHub 連携解除 (docs/github-oauth.md、2026-07-20)。issue/PR 同期は次フェーズなので、
// ここでは github_connections の行を消すだけ (Google の revoke 相当は無い — GitHub App の
// user-to-server トークンは App 側の Installations 画面から取り消す運用を想定)。
githubRoutes.delete("/api/github", requireAuth, async (c) => {
  const profileId = c.get("profileId")!;
  await c.env.DB.prepare("DELETE FROM github_connections WHERE profile_id = ?")
    .bind(profileId)
    .run();
  return c.body(null, 204);
});

// GitHub アイテム取得 (docs/github-integration.md フェーズ①、2026-07-20)。milestone 期日 +
// その milestone の open issue/PR を取って DTO で返すだけ (サーバーは永続化しない、
// Google の /api/sync と同じ思想)。表示 (専用レーン) は Part B で別途。
// - 未連携 (github_connections に行が無い) は 409 github_not_connected。
// - 復号できない/GitHub が 401 を返す (トークン失効) は 401 github_auth_expired
//   (将来の再連携導線用に区別しておく)。
// - それ以外の GitHub API 失敗は一律 502 github_fetch_failed (/api/event/patch 等の
//   一律マッピング方針と同じ — 理由ごとの分岐をクライアントに要求しない)。
githubRoutes.get("/api/github/items", requireAuth, async (c) => {
  return withGitHubToken(c, "github items", async (token) => {
    const items = await fetchGitHubItems({ fetch, token });
    return c.json<GitHubItemsResponse>({ items });
  });
});

// GitHub 作業キュー取得 (docs/github-integration.md フェーズ②「作業キュー」、2026-07-20)。
// review request / assigned issue / 自分の open PR を Search API 横断で取って DTO で返す
// だけ (サーバーは永続化しない)。表示 (サイドレール) は Part B で別途。
// エラーマッピングは /api/github/items と同じ (resolveGitHubAccessToken を共有)。
githubRoutes.get("/api/github/queue", requireAuth, async (c) => {
  return withGitHubToken(c, "github queue", async (token) => {
    const items = await fetchGitHubQueue({ fetch, token });
    return c.json<GitHubQueueResponse>({ items });
  });
});

// GitHub 実績オーバーレイ取得 (docs/github-integration.md フェーズ③「実績オーバーレイ」
// Part A、2026-07-20)。インストール先 repo に対して自分の commit 活動 (author=login) を
// since/until (クライアントが渡す表示中の時間帯) で取って DTO で返すだけ (サーバーは
// 永続化しない)。表示 (グリッドへの薄いオーバーレイ) は Part B で別途。
// - since/until が無ければ 400 missing_range (per-repo commit 取得を範囲限定するための
//   必須パラメータ)。
// - 範囲が MAX_ACTIVITY_RANGE_DAYS を超えたら 400 range_too_wide (per-repo 反復が膨らむのを防ぐ)。
// - エラーマッピングは /api/github/items・/api/github/queue と同じ (resolveGitHubAccessToken
//   を共有)。
// since/until の検証自体は /api/github/ci (フェーズ④b) と共通なので parseRequiredRange に
// 切り出してある (挙動・エラーコードは変えていない)。
const MAX_ACTIVITY_RANGE_DAYS = 62;

githubRoutes.get("/api/github/activity", requireAuth, async (c) => {
  const range = parseRequiredRange(c, MAX_ACTIVITY_RANGE_DAYS);
  if (!range.ok) {
    return c.json<ApiError>({ error: range.error }, 400);
  }

  return withGitHubToken(c, "github activity", async (token, login) => {
    const items = await fetchGitHubActivity({
      fetch,
      token,
      login,
      sinceIso: range.sinceIso,
      untilIso: range.untilIso,
    });
    return c.json<GitHubActivityResponse>({ items });
  });
});

// GitHub CI/Actions 実行取得 (docs/github-integration.md フェーズ④b「CI/Actions 実行を
// タイムラインに薄く重ねる」、2026-07-20)。インストール先 repo に対して workflow run を
// since/until (クライアントが渡す表示中の時間帯) で取って DTO で返すだけ (サーバーは
// 永続化しない)。/api/github/activity (フェーズ③) と同じ流儀だが、③ と違い自分がトリガーした
// 分に限定しない (誰の push の CI 実行でも見える、core/github-ci.ts 参照)。
// - since/until の検証は /api/github/activity と共通 (parseRequiredRange)。
// - エラーマッピングも /api/github/activity と同じ (resolveGitHubAccessToken を共有)。
const MAX_CI_RANGE_DAYS = 62;

githubRoutes.get("/api/github/ci", requireAuth, async (c) => {
  const range = parseRequiredRange(c, MAX_CI_RANGE_DAYS);
  if (!range.ok) {
    return c.json<ApiError>({ error: range.error }, 400);
  }

  return withGitHubToken(c, "github ci", async (token) => {
    const items = await fetchGitHubCiRuns({ fetch, token }, range.sinceIso, range.untilIso);
    return c.json<GitHubCiRunsResponse>({ items });
  });
});

// PR ごとの自分の commit 時刻取得 (docs/github-integration.md フェーズ③「時間計測」Part A、
// 2026-07-20)。予定ブロックに紐づく PR のリストを受け取り、各 PR について自分 (login) の
// commit の ISO タイムスタンプ配列を返すだけ (サーバーは永続化しない)。クラスタリングして
// 実績時間として見せる UI は Part B で別途 (このエンドポイントは生の時刻列を返すのみ)。
// - items が配列でない/各要素の repo・number の型が不正なら 400 missing_fields。
// - items が空配列なら GitHub を叩かず即 200 { commitsByItem: {} }。
// - エラーマッピングは /api/github/items・/api/github/queue・/api/github/activity と同じ
//   (resolveGitHubAccessToken を共有)。ただし 1 PR 単位の失敗は
//   core/github-pr-commits.ts の fetchPullCommitsForItems が内部で握って継続するので、
//   ここまで届くのはトークン失効など全体に関わる失敗のみ。
githubRoutes.post("/api/github/pr-commits", requireAuth, async (c) => {
  const body = await readJsonBody<PullCommitsRequest>(c);
  if (body === INVALID_JSON) return c.json<ApiError>({ error: "invalid_json" }, 400);
  if (
    !Array.isArray(body?.items) ||
    body.items.some(
      (item) =>
        typeof item?.repo !== "string" ||
        item.repo.length === 0 ||
        typeof item?.number !== "number",
    )
  ) {
    return c.json<ApiError>({ error: "missing_fields" }, 400);
  }

  if (body.items.length === 0) {
    return c.json<PullCommitsResponse>({ commitsByItem: {} });
  }

  return withGitHubToken(c, "github pr-commits", async (token, login) => {
    const commitsByItem = await fetchPullCommitsForItems({ fetch, token, login }, body.items);
    return c.json<PullCommitsResponse>({ commitsByItem });
  });
});

// 認証ユーザーが見えるリポジトリ一覧 (実績 UX 刷新フェーズ3「手動追加フォームのプルダウン化」、
// 2026-07-23)。WorkLogModal の org/repo カスケードプルダウンの元データ。GitHub App の
// インストール先 (listInstallationRepos、/api/github/items と同じ範囲) を owner/repo で返すだけ
// (サーバーは永続化しない)。エラーマッピングは /api/github/items 等と同じ
// (resolveGitHubAccessToken を共有)。
githubRoutes.get("/api/github/repos", requireAuth, async (c) => {
  return withGitHubToken(c, "github repos", async (token) => {
    const repos = await listInstallationRepos(fetch, token);
    return c.json<GitHubReposResponse>({ repos });
  });
});

// 1 リポジトリの open な issue / PR 一覧 (実績 UX 刷新フェーズ3、2026-07-23)。WorkLogModal で
// repo を選んだときに、その repo の issue/PR プルダウンを埋めるために叩く。クエリ `repo` は
// "owner/repo" 形式 — parseOwnerRepo で検証し、不正なら 400 invalid_repo。それ以外の
// エラーマッピングは /api/github/items 等と同じ (resolveGitHubAccessToken を共有)。
githubRoutes.get("/api/github/repo-issues", requireAuth, async (c) => {
  const repoParam = c.req.query("repo");
  const ownerRepo = repoParam ? parseOwnerRepo(repoParam) : null;
  if (!ownerRepo) {
    return c.json<ApiError>({ error: "invalid_repo" }, 400);
  }

  return withGitHubToken(c, "github repo-issues", async (token) => {
    const issues = await listOpenRepoIssues(fetch, token, ownerRepo.owner, ownerRepo.repo);
    return c.json<GitHubRepoIssuesResponse>({ issues });
  });
});

/**
 * GET /api/github/activity・/api/github/ci 共通: クエリの since/until を検証する
 * (docs/github-integration.md フェーズ③④b、2026-07-20 DRY 化)。since/until が無い、または
 * Date.parse できなければ missing_range、範囲が maxRangeDays を超えれば range_too_wide を
 * 返す (エラーコード・判定基準は元々2ルートで重複していたコードと同一、挙動は変えていない)。
 */
type RangeValidation =
  | { ok: true; sinceIso: string; untilIso: string }
  | { ok: false; error: "missing_range" | "range_too_wide" };

function parseRequiredRange(c: Context<AppEnv>, maxRangeDays: number): RangeValidation {
  const sinceIso = c.req.query("since");
  const untilIso = c.req.query("until");
  if (!sinceIso || !untilIso) {
    return { ok: false, error: "missing_range" };
  }
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    return { ok: false, error: "missing_range" };
  }
  const rangeDays = (untilMs - sinceMs) / (24 * 60 * 60 * 1000);
  if (rangeDays > maxRangeDays) {
    return { ok: false, error: "range_too_wide" };
  }
  return { ok: true, sinceIso, untilIso };
}

/**
 * GET /api/github/items・/api/github/queue・/api/github/activity で共通のトークン解決
 * (docs/github-integration.md フェーズ①②③、2026-07-20)。github_connections を profileId で
 * 引いて復号するだけの処理が各ルートで重複していたので DRY 化した — 挙動 (未連携 409 /
 * 復号失敗 401) は変えていない。
 * `login` も併せて返す (フェーズ③の commits API が author=login を要求するため、
 * github_login を SELECT に追加して拡張した — 既存の呼び出し側 (①②) は login を無視する
 * だけなので非破壊)。
 */
type GitHubTokenResolution =
  | { ok: true; token: string; login: string }
  | { ok: false; error: "github_not_connected" | "github_auth_expired"; status: 409 | 401 };

async function resolveGitHubAccessToken(
  env: Env,
  profileId: string,
  logPrefix: string,
): Promise<GitHubTokenResolution> {
  const connection = await env.DB.prepare(
    "SELECT access_token, github_login FROM github_connections WHERE profile_id = ?",
  )
    .bind(profileId)
    .first<{ access_token: string; github_login: string }>();
  if (!connection) {
    return { ok: false, error: "github_not_connected", status: 409 };
  }

  try {
    const token = await decryptToken(env.TOKEN_ENC_KEY, connection.access_token);
    return { ok: true, token, login: connection.github_login };
  } catch (err) {
    if (!(err instanceof InvalidCiphertextError)) throw err;
    console.warn(`${logPrefix}: could not decrypt access_token for profile ${profileId}`);
    return { ok: false, error: "github_auth_expired", status: 401 };
  }
}

/**
 * 7つの GitHub ルートで繰り返されていた「トークン解決 → 実処理 → GitHubApiError(401) は
 * github_auth_expired、それ以外は github_fetch_failed」の15行ブロックを1箇所にまとめたもの。
 * エラーマッピング・ログ文字列・ステータスコードは元のブロックと完全に同一 (挙動は変えていない)。
 */
async function withGitHubToken(
  c: Context<AppEnv>,
  label: string,
  fn: (token: string, login: string) => Promise<Response>,
): Promise<Response> {
  const profileId = c.get("profileId")!;

  const resolved = await resolveGitHubAccessToken(c.env, profileId, label);
  if (!resolved.ok) {
    return c.json<ApiError>({ error: resolved.error }, resolved.status);
  }

  try {
    return await fn(resolved.token, resolved.login);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      console.warn(`${label}: GitHub rejected the access token for profile ${profileId}`);
      return c.json<ApiError>({ error: "github_auth_expired" }, 401);
    }
    console.error(`${label}: fetch failed for profile ${profileId}`, err);
    return c.json<ApiError>({ error: "github_fetch_failed" }, 502);
  }
}
