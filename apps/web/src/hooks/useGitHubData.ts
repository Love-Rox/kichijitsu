import { useCallback, useEffect, useState } from "react";
import type { Temporal } from "@js-temporal/polyfill";
import type { IDBPDatabase } from "idb";
import type {
  GitHubActivityDTO,
  GitHubCiRunDTO,
  GitHubConnectionDTO,
  GitHubItemDTO,
  GitHubItemsResponse,
  GitHubQueueResponse,
  GitHubRepoIssue,
  GitHubRepoRef,
  GitHubWorkItemDTO,
  PullCommitsRequest,
  PullCommitsResponse,
} from "@kichijitsu/shared";
import { clearGitHubItems, putGitHubItems, type KichijitsuDB } from "../db/database";
import type { View } from "../keyboard/shortcuts";
import { timelineRangeMs } from "../layout/viewRange";
import type { GitHubStore } from "../store/githubStore";
import { collectPrTargets, estimateByItemKey } from "../sync/estimateActual";
import {
  classifyGitHubResponse,
  fetchGitHubActivityViaGh,
  fetchGitHubCiRunsViaGh,
  fetchGitHubItemsViaGh,
  fetchPullCommitsViaGh,
  fetchRepoIssues,
  fetchRepos,
  fetchWorkQueueViaGh,
  isTauri,
} from "../sync/githubProvider";
import { jsonInit, type CheckedFetch } from "../sync/httpJson";
import { mapGitHubItems } from "../sync/mapGitHub";

/**
 * GitHub 連携 (docs/github-integration.md) のデータ取得をまとめたフック。App.tsx から
 * 「state + 取得 effect + 表示トグル + ハンドラ」をそのまま持ってきたもの
 * (リファクタリング フェーズ2 ③、2026-07-25)。扱う経路は5本:
 *
 *  1. **アイテム** (`GET /api/github/items`): milestone/issue/PR/release のレーン。応答は常に
 *     完全なスナップショットなので IndexedDB/githubStore を「全消し→全書き込み」で置き換える。
 *  2. **実績オーバーレイ** (`GET /api/github/activity`): 表示中の時間範囲ぶんの commit。
 *  3. **CI/Actions 実行** (`GET /api/github/ci`): 同じく表示範囲ぶん。
 *  4. **作業キュー** (`GET /api/github/queue`): 日付を持たないライブな一覧。
 *  5. **PR commit 推定** (`POST /api/github/pr-commits`): レポート/実績セクション用
 *     (下の useGitHubPrCommitEstimates。App.tsx の後半で計算する値に依存するため別フック)。
 *
 * どれも `isTauri()` で「手元の gh CLI 認証で直接叩く」経路と「Worker のサーバー経路」を
 * 出し分ける (docs/github-integration.md「認証プロバイダの抽象化」)。gh 経路とサーバー経路で
 * エラー時の畳み方が違う (gh は失敗で空にする、サーバーは 502/ネットワークエラーでは前回表示を
 * 維持する) のは意図的で、移設時もそのまま保っている。
 *
 * 2 と 3 は「表示範囲を ISO 化 → 300ms デバウンス → isTauri() 分岐 → 401/409/非2xx の三分岐 →
 * state 置き換え」がまったく同じだったので、内部ヘルパー useGitHubRangeResource に共通化した
 * (トグルハンドラも同型なので一緒に入れてある)。三分岐の判定そのものは純関数
 * sync/githubProvider.ts の classifyGitHubResponse が持ち、テストで固めている。
 */

/** 表示範囲連動オーバーレイ (activity / ci) の1本ぶんの状態とハンドラ。 */
interface GitHubRangeResource<T> {
  /** 直近の取得結果。トグル OFF・連携解除で空になる */
  items: T[];
  /** オーバーレイの表示 ON/OFF。OFF の間は取得もしない */
  visible: boolean;
  /** ツールバーのトグルから呼ぶ。OFF にした瞬間に items も空にする */
  toggleVisible: () => void;
  /** 連携解除で state を畳む(visible は変えない) */
  clear: () => void;
}

/**
 * 表示範囲 ([timelineStart, +dayCount日)) に連動して取り直すオーバーレイ1本ぶんの共通実装。
 * activity (フェーズ③Part B) と ci (フェーズ④b) が完全に同じ流儀だったため共通化した。
 *
 * 挙動の要点(移設前のコメントから引き継ぎ):
 *  - ビュー切替・週送りの連打で過剰リクエストにならないよう **300ms デバウンス** する。
 *  - トグル OFF・未連携・月表示 (WeekGrid 自体が描画されない) では取得しない。
 *  - 401 は呼び出し側の githubAuthExpired 経路に合流させる(activity/ci/items で同じ
 *    resolveGitHubAccessToken を共有しているため専用フラグは持たない)。409 は未連携相当として
 *    空にし、502・ネットワークエラーは一時的な失敗として warn のみ(前回表示を維持)。
 *  - 依存配列は移設前と同じ組 (github の **オブジェクト同一性** を含む) を保つ。boolean に
 *    畳むと /api/me の再取得(online 復帰)で取り直さなくなり挙動が変わってしまう。
 */
function useGitHubRangeResource<T>({
  github,
  view,
  timelineStart,
  dayCount,
  timeZone,
  checkedFetch,
  setAuthExpired,
  path,
  viaGh,
  ghLabel,
  initialVisible,
}: {
  github: GitHubConnectionDTO | null;
  view: View;
  timelineStart: Temporal.PlainDate;
  dayCount: number;
  timeZone: string;
  checkedFetch: CheckedFetch;
  /** 401 で true、成功で false を書き込む(呼び出し側の githubAuthExpired) */
  setAuthExpired: (expired: boolean) => void;
  /** サーバー経路のパス (`/api/github/activity` 等)。warn メッセージにもそのまま使う */
  path: string;
  /** gh 経路の取得関数 (since/until は ISO 8601) */
  viaGh: (sinceIso: string, untilIso: string) => Promise<T[]>;
  /** gh 経路の warn メッセージに埋める日本語ラベル (「GitHub 実績」等) */
  ghLabel: string;
  /** 表示トグルの初期値。実績は既定 ON、CI は件数が膨らみやすいので既定 OFF */
  initialVisible: boolean;
}): GitHubRangeResource<T> {
  const [items, setItems] = useState<T[]>([]);
  const [visible, setVisible] = useState(initialVisible);

  useEffect(() => {
    if (!github || !visible || view === "month") return;
    const { fromMs, toMs } = timelineRangeMs(timelineStart, dayCount, timeZone);
    const sinceIso = new Date(fromMs).toISOString();
    const untilIso = new Date(toMs).toISOString();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // プロバイダ分岐 (①アイテム取得と同じ流儀)。Tauri デスクトップ実行時のみ、手元の
      // gh CLI 認証で直接取得する。ブラウザ/PWA では isTauri() が常に false のため
      // 以降の従来コードは不変。
      if (isTauri()) {
        viaGh(sinceIso, untilIso)
          .then((fetched) => {
            if (!cancelled) {
              setAuthExpired(false);
              setItems(fetched);
            }
          })
          .catch((err) => {
            console.warn(`kichijitsu: gh 経由の ${ghLabel}取得に失敗`, err);
            if (!cancelled) setItems([]);
          });
        return;
      }

      checkedFetch(
        `${path}?since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}`,
      )
        .then(async (res) => {
          const kind = classifyGitHubResponse(res.status);
          if (kind === "auth_expired") {
            if (!cancelled) setAuthExpired(true);
            return;
          }
          if (kind === "not_connected") {
            if (!cancelled) setItems([]);
            return;
          }
          if (kind === "transient") {
            console.warn(`kichijitsu: GET ${path} failed: ${res.status}`);
            return;
          }
          const data = (await res.json()) as { items: T[] };
          if (!cancelled) {
            setAuthExpired(false);
            setItems(data.items);
          }
        })
        .catch((err) => {
          console.warn(`kichijitsu: GET ${path} failed`, err);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    github,
    visible,
    view,
    timelineStart,
    dayCount,
    timeZone,
    checkedFetch,
    setAuthExpired,
    path,
    viaGh,
    ghLabel,
  ]);

  // トグル OFF: 次の取得を待たず即座にレールを消す(cancelled フラグだけだと
  // 直前の取得がまだ in-flight の場合に一瞬残ってしまうため、明示的に空にする)
  const toggleVisible = useCallback(() => {
    setVisible((prev) => {
      const next = !prev;
      if (!next) setItems([]);
      return next;
    });
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, visible, toggleVisible, clear };
}

export interface GitHubDataController {
  /**
   * `GET /api/github/items` 等が 401 github_auth_expired を返したかどうか。設定モーダルが
   * 「再連携」導線を出すのに使う。409 github_not_connected / 502 github_fetch_failed では
   * 立てない(前者は me.github が null のはずで無関係、後者は一時的な取得失敗なので再連携は不要)
   */
  githubAuthExpired: boolean;
  /** PR commit 推定 (useGitHubPrCommitEstimates) も同じフラグへ合流させるため公開する */
  setGithubAuthExpired: (expired: boolean) => void;
  /** 作業キュー。日付を持たないライブな一覧なので IndexedDB には入れず state だけで持つ */
  githubQueue: GitHubWorkItemDTO[];
  queueLoading: boolean;
  /**
   * 401 github_auth_expired 専用フラグ(githubAuthExpired とは独立: レーン用の
   * /api/github/items とキュー用の /api/github/queue は別エンドポイントで、
   * 片方だけ失効することは無い想定だが、UI 側の責務は分けておく)
   */
  queueAuthExpired: boolean;
  /** ペインの手動更新 (onRefresh) から呼ぶ。ペインを開いた時・連携直後は内部の effect が呼ぶ */
  fetchGithubQueue: () => void;
  githubActivity: GitHubActivityDTO[];
  activityVisible: boolean;
  toggleActivityVisible: () => void;
  githubCiRuns: GitHubCiRunDTO[];
  ciVisible: boolean;
  toggleCiVisible: () => void;
  /** 右ペインの手動記録フォーム(org/repo/issue カスケード)用 */
  fetchReposForPane: () => Promise<GitHubRepoRef[]>;
  fetchRepoIssuesForPane: (repo: string) => Promise<GitHubRepoIssue[]>;
  /** 連携解除時に GitHub 由来のローカルデータ(state + IndexedDB/store)を畳む */
  clearGitHubData: () => Promise<void>;
}

/**
 * @param db IndexedDB ハンドル(未オープンの間はアイテム取得をしない)
 * @param github 連携情報 (me.github)。null の間はどの経路も取得しない
 * @param githubStore アイテムレーンの読み口。取得成功時に clear→load で置き換える
 * @param paneOpen 右ペイン (GitHubPane) が開いているか。開いた瞬間に作業キューを取り直す
 * @param view 月表示ではオーバーレイを取得しない(WeekGrid 自体が描画されない)
 * @param timelineStart 表示範囲の先頭日(オーバーレイの since/until を導く)
 * @param dayCount 表示日数
 * @param timeZone 表示タイムゾーン
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 */
export function useGitHubData({
  db,
  github,
  githubStore,
  paneOpen,
  view,
  timelineStart,
  dayCount,
  timeZone,
  checkedFetch,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  github: GitHubConnectionDTO | null;
  githubStore: GitHubStore;
  paneOpen: boolean;
  view: View;
  timelineStart: Temporal.PlainDate;
  dayCount: number;
  timeZone: string;
  checkedFetch: CheckedFetch;
}): GitHubDataController {
  const [githubAuthExpired, setGithubAuthExpired] = useState(false);
  const [githubQueue, setGithubQueue] = useState<GitHubWorkItemDTO[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueAuthExpired, setQueueAuthExpired] = useState(false);

  // GitHub アイテムの取得(docs/github-integration.md フェーズ①Part B)。db 準備完了 &
  // me.github が連携済みになったら GET /api/github/items を取る。サーバーは GitHub アイテムを
  // 永続化せず応答は常に完全なスナップショットのため、成功したら IndexedDB/store を
  // 「全消し→全書き込み」で置き換える(clearGitHubItems/githubStore.clear、差分計算はしない)。
  // 409 github_not_connected は me.github が null のはずで基本発生しない(念のため無視)。
  // 401 github_auth_expired は再連携導線 (CalendarSettingsPanel) を出すためフラグを立てる。
  // 502 github_fetch_failed・ネットワークエラーは一時的な失敗として warn のみ(レーンは前回の
  // キャッシュ表示のまま据え置く)
  useEffect(() => {
    if (!db || !github) return;
    let cancelled = false;

    // 取得できた GitHubItemDTO[] を IndexedDB/store に反映する共通処理 (gh 経路・Worker 経路で
    // 収束させる、docs/github-integration.md「認証プロバイダの抽象化」)。
    const apply = async (items: GitHubItemDTO[]) => {
      const mapped = mapGitHubItems(items);
      if (cancelled || !db) return;
      setGithubAuthExpired(false);
      await clearGitHubItems(db);
      await putGitHubItems(db, mapped);
      await githubStore.batch(async () => {
        githubStore.clear();
        githubStore.load(mapped);
      });
    };

    // プロバイダ分岐 (fetchGithubQueue と同じ流儀)。Tauri デスクトップ実行時のみ、手元の
    // gh CLI 認証でアイテムを直接取得する。ブラウザ/PWA では isTauri() が常に false のため
    // 以降の従来コードは不変。
    if (isTauri()) {
      fetchGitHubItemsViaGh()
        .then((items) => apply(items))
        .catch((err) => {
          console.warn("kichijitsu: gh 経由の GitHub アイテム取得に失敗", err);
        });
      return () => {
        cancelled = true;
      };
    }

    checkedFetch("/api/github/items")
      .then(async (res) => {
        const kind = classifyGitHubResponse(res.status);
        if (kind === "auth_expired") {
          if (!cancelled) setGithubAuthExpired(true);
          return;
        }
        if (kind === "not_connected") return; // 未連携(通常は me.github が null のはずなので無視)
        if (kind === "transient") {
          console.warn(`kichijitsu: GET /api/github/items failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as GitHubItemsResponse;
        await apply(data.items);
      })
      .catch((err) => {
        console.warn("kichijitsu: GET /api/github/items failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [db, github, checkedFetch, githubStore]);

  // GitHub 実績オーバーレイ(フェーズ③Part B)。既定 ON。
  const {
    items: githubActivity,
    visible: activityVisible,
    toggleVisible: toggleActivityVisible,
    clear: clearActivity,
  } = useGitHubRangeResource<GitHubActivityDTO>({
    github,
    view,
    timelineStart,
    dayCount,
    timeZone,
    checkedFetch,
    setAuthExpired: setGithubAuthExpired,
    path: "/api/github/activity",
    viaGh: fetchGitHubActivityViaGh,
    ghLabel: "GitHub 実績",
    initialVisible: true,
  });

  // CI/Actions 実行オーバーレイ(フェーズ④b)。実績 (commit) と違い CI 実行は自分のトリガー分に
  // 限定しないぶん件数が膨らみやすい(誰の push でも表示対象)ため、既定は OFF にして明示的な
  // オプトインにする(activityVisible の既定 ON とは意図的に非対称)。
  const {
    items: githubCiRuns,
    visible: ciVisible,
    toggleVisible: toggleCiVisible,
    clear: clearCiRuns,
  } = useGitHubRangeResource<GitHubCiRunDTO>({
    github,
    view,
    timelineStart,
    dayCount,
    timeZone,
    checkedFetch,
    setAuthExpired: setGithubAuthExpired,
    path: "/api/github/ci",
    viaGh: fetchGitHubCiRunsViaGh,
    ghLabel: "GitHub CI 実行",
    initialVisible: false,
  });

  // 作業キューの取得(docs/github-integration.md フェーズ②Part B)。GET /api/github/queue は
  // サーバー側で永続化しない都度取得の一覧なので、成功したら githubQueue を丸ごと置き換えるだけ
  // (差分計算はしない、/api/github/items と同じ「全消し→全書き込み」の考え方だが
  // こちらは IndexedDB を経由しないぶん単純)。401/409/502 のマッピングは /api/github/items と
  // 同じ(408 は無し)。ドロワーを開いた時と onRefresh の両方からこの1つの関数を呼ぶ。
  const fetchGithubQueue = useCallback(() => {
    if (!github) return;
    setQueueLoading(true);

    // プロバイダ分岐 (docs/github-integration.md「認証プロバイダの抽象化」)。
    // Tauri デスクトップ実行時のみ、手元の gh CLI 認証で作業キューを直接取得する。
    // ブラウザ/PWA では isTauri() が常に false になるため、以降の従来コードは不変。
    if (isTauri()) {
      fetchWorkQueueViaGh()
        .then((items) => {
          setQueueAuthExpired(false);
          setGithubQueue(items);
        })
        .catch((err) => {
          // gh 未インストール/未ログイン等。空扱いにして warn (OAuth 連携案内は次増分 TODO)。
          console.warn("kichijitsu: gh 経由の作業キュー取得に失敗", err);
          setGithubQueue([]);
        })
        .finally(() => setQueueLoading(false));
      return;
    }

    checkedFetch("/api/github/queue")
      .then(async (res) => {
        const kind = classifyGitHubResponse(res.status);
        if (kind === "auth_expired") {
          setQueueAuthExpired(true);
          return;
        }
        if (kind === "not_connected") {
          // 未連携(通常は me.github が null のはずなので基本発生しない)。空扱いにする
          setGithubQueue([]);
          return;
        }
        if (kind === "transient") {
          console.warn(`kichijitsu: GET /api/github/queue failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as GitHubQueueResponse;
        setQueueAuthExpired(false);
        setGithubQueue(data.items);
      })
      .catch((err) => {
        console.warn("kichijitsu: GET /api/github/queue failed", err);
      })
      .finally(() => setQueueLoading(false));
  }, [github, checkedFetch]);

  // 右ペイン(GitHubPane)の手動記録フォーム用の repo / repo-issues 取得(実績 UX 刷新
  // フェーズ3、2026-07-23。2026-07-25 に WorkLogModal からペインへ移設)。githubProvider の
  // 統一 API を checkedFetch でバインドして渡すだけ — isTauri() の gh/server 分岐は
  // githubProvider 側が担う(fetchGithubQueue と同じ考え方)。失敗時の手入力フォールバックは
  // ペイン側が握る。実績履歴の issue タイトル補完も fetchRepoIssuesForPane を使う。
  const fetchReposForPane = useCallback(() => fetchRepos(checkedFetch), [checkedFetch]);
  const fetchRepoIssuesForPane = useCallback(
    (repo: string) => fetchRepoIssues(repo, checkedFetch),
    [checkedFetch],
  );

  // 連携直後の初回取得(me.github が null→非null になったタイミング)。ドロワーを
  // 開く前でもヘッダーの件数バッジを最新化できるようにする
  useEffect(() => {
    if (!github) return;
    fetchGithubQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github]);

  // ペインを開くたびの取得(手動更新は onRefresh=fetchGithubQueue の直接呼び出し)
  useEffect(() => {
    if (!paneOpen) return;
    fetchGithubQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneOpen]);

  /**
   * GitHub 連携解除 (docs/github-integration.md フェーズ①Part B) のローカル側の畳み込み。
   * DELETE /api/github と me.github の更新は呼び出し側 (App.tsx の handleDisconnectGitHub) が
   * 行い、ここは「このフックが持っているものを全部空にする」だけを担う。作業キュー・
   * 実績/CI オーバーレイは IndexedDB に入れていないので state を空にするだけでよく、
   * アイテムレーンだけ IndexedDB/store の両方を消す。
   */
  const clearGitHubData = useCallback(async () => {
    setGithubAuthExpired(false);
    setGithubQueue([]);
    setQueueAuthExpired(false);
    clearActivity();
    clearCiRuns();
    if (db) {
      await clearGitHubItems(db);
      await githubStore.batch(async () => {
        githubStore.clear();
      });
    }
  }, [db, githubStore, clearActivity, clearCiRuns]);

  return {
    githubAuthExpired,
    setGithubAuthExpired,
    githubQueue,
    queueLoading,
    queueAuthExpired,
    fetchGithubQueue,
    githubActivity,
    activityVisible,
    toggleActivityVisible,
    githubCiRuns,
    ciVisible,
    toggleCiVisible,
    fetchReposForPane,
    fetchRepoIssuesForPane,
    clearGitHubData,
  };
}

/** collectPrTargets が要求する最小形(PlannedBlock / TimeEntry の共通部分)。 */
interface PrTargetSource {
  itemType: "issue" | "pr";
  repo: string;
  number: number;
}

export interface GitHubPrCommitEstimates {
  /** キー "{owner/repo}#{number}" → commit から推定した実績 ms */
  prCommitEstimates: Record<string, number>;
  prCommitEstimatesLoading: boolean;
}

/**
 * commit からの実績自動推定 (docs/github-integration.md「時間計測」増分3 Part B)。
 *
 * useGitHubData と別フックにしてあるのは、依存する `enabled` (needsActualsData) と
 * plannedBlocks/timeEntries が App.tsx のかなり後半で計算される値で、useGitHubData の
 * 呼び出し位置(= effect 登録順)からは参照できないため。401 は useGitHubData の
 * githubAuthExpired へ合流させる(setAuthExpired を渡してもらう)。
 *
 * @param enabled needsActualsData(レポートを開いた、または実績セクションが可視)
 * @param github 未連携なら取得せず推定列は空のまま(enabled の paneOpen 経路は既に me.github を
 *   含むが、reportOpen 経路は含まないため引き続きここで明示的にガードする)
 * @param plannedBlocks 予定タイムブロック(PR のみ対象、issue は commit と紐づかないため送らない)
 * @param timeEntries 走行中/記録済みの実績エントリ(同じく PR のみ対象)
 */
export function useGitHubPrCommitEstimates({
  enabled,
  github,
  plannedBlocks,
  timeEntries,
  checkedFetch,
  setAuthExpired,
}: {
  enabled: boolean;
  github: GitHubConnectionDTO | null;
  plannedBlocks: PrTargetSource[];
  timeEntries: PrTargetSource[];
  checkedFetch: CheckedFetch;
  setAuthExpired: (expired: boolean) => void;
}): GitHubPrCommitEstimates {
  const [prCommitEstimates, setPrCommitEstimates] = useState<Record<string, number>>({});
  const [prCommitEstimatesLoading, setPrCommitEstimatesLoading] = useState(false);

  // enabled のときだけ POST /api/github/pr-commits を叩く(interval 等の常時ポーリングはしない)。
  // 対象は plannedBlocks/timeEntries から集めた PR (itemType==='pr') の {repo, number} のみ。
  // 401→githubAuthExpired 経路に合流(①②と同じ再連携導線を共有)、409(未連携相当、通常は
  // me.github が null のはずなので基本発生しない)は空扱い、502・ネットワークエラーは一時的な
  // 失敗として warn のみ(前回の推定を維持する)。
  useEffect(() => {
    if (!enabled || !github) return;
    const prItems = collectPrTargets(plannedBlocks, timeEntries);
    if (prItems.length === 0) {
      setPrCommitEstimates({});
      return;
    }
    let cancelled = false;
    setPrCommitEstimatesLoading(true);

    // プロバイダ分岐 (①アイテム取得と同じ流儀)。Tauri デスクトップ実行時のみ、手元の
    // gh CLI 認証で PR commit を直接取得する。ブラウザ/PWA では isTauri() が常に false
    // のため以降の従来コードは不変。
    if (isTauri()) {
      fetchPullCommitsViaGh(prItems)
        .then((commitsByItem) => {
          if (!cancelled) {
            setAuthExpired(false);
            setPrCommitEstimates(estimateByItemKey(commitsByItem));
          }
        })
        .catch((err) => {
          console.warn("kichijitsu: gh 経由の PR commit 取得に失敗", err);
          if (!cancelled) setPrCommitEstimates({});
        })
        .finally(() => {
          if (!cancelled) setPrCommitEstimatesLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    checkedFetch(
      "/api/github/pr-commits",
      jsonInit("POST", { items: prItems } satisfies PullCommitsRequest),
    )
      .then(async (res) => {
        const kind = classifyGitHubResponse(res.status);
        if (kind === "auth_expired") {
          if (!cancelled) setAuthExpired(true);
          return;
        }
        if (kind === "not_connected") {
          if (!cancelled) setPrCommitEstimates({});
          return;
        }
        if (kind === "transient") {
          console.warn(`kichijitsu: POST /api/github/pr-commits failed: ${res.status}`);
          return;
        }
        const data = (await res.json()) as PullCommitsResponse;
        if (!cancelled) {
          setAuthExpired(false);
          setPrCommitEstimates(estimateByItemKey(data.commitsByItem));
        }
      })
      .catch((err) => {
        console.warn("kichijitsu: POST /api/github/pr-commits failed", err);
      })
      .finally(() => {
        if (!cancelled) setPrCommitEstimatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, github, plannedBlocks, timeEntries, checkedFetch, setAuthExpired]);

  return { prCommitEstimates, prCommitEstimatesLoading };
}
