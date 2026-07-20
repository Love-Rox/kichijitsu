import { fetchAllPages, GITHUB_API_BASE } from "./http";

/**
 * GitHub App をインストールしたリポジトリの一覧 (docs/github-integration.md フェーズ①)。
 * 「リポジトリ範囲 = GitHub App をインストールしたリポジトリに限定」の方針により、
 * まず `GET /user/installations` で installation を列挙し、各 installation ごとに
 * `GET /user/installations/{id}/repositories` で対象リポジトリを取る。
 *
 * 合計件数に安全上限 (MAX_REPOS) を設ける — API 負荷を有界にするため。超過分は
 * 切り捨て、console.warn で1度だけ知らせる (呼び出し元を落とすほどの異常ではない)。
 */
const MAX_REPOS = 100;

export interface InstalledRepo {
  owner: string;
  repo: string;
}

interface RawInstallation {
  id: number;
}

interface InstallationsResponseBody {
  total_count: number;
  installations: RawInstallation[];
}

interface RawInstallationRepo {
  name: string;
  owner: { login: string };
}

interface InstallationRepositoriesResponseBody {
  total_count: number;
  repositories: RawInstallationRepo[];
}

export async function listInstallationRepos(
  fetchFn: typeof fetch,
  token: string,
): Promise<InstalledRepo[]> {
  const installations = await fetchAllPages<RawInstallation>(
    fetchFn,
    `${GITHUB_API_BASE}/user/installations?per_page=100`,
    token,
    (body) => (body as InstallationsResponseBody).installations ?? [],
  );

  const repos: InstalledRepo[] = [];
  for (const installation of installations) {
    const installationRepos = await fetchAllPages<RawInstallationRepo>(
      fetchFn,
      `${GITHUB_API_BASE}/user/installations/${installation.id}/repositories?per_page=100`,
      token,
      (body) => (body as InstallationRepositoriesResponseBody).repositories ?? [],
    );

    for (const raw of installationRepos) {
      if (repos.length >= MAX_REPOS) {
        console.warn(
          `listInstallationRepos: exceeded safety cap of ${MAX_REPOS} repos across installations; truncating`,
        );
        return repos;
      }
      repos.push({ owner: raw.owner.login, repo: raw.name });
    }
  }
  return repos;
}
