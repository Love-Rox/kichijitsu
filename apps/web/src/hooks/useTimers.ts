import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  GitHubConnectionDTO,
  GitHubWorkItemDTO,
  OpenWorkIntervalDTO,
  OpenWorkIntervalsResponse,
  WorkIntervalStartRequest,
  WorkIntervalStopRequest,
  WorkIntervalStopResponse,
} from "@kichijitsu/shared";
import type { TimeEntry } from "../model/types";
import type { PlannedStore } from "../store/plannedStore";
import { useRunningTimeEntries, type TimeEntryStore } from "../store/timeEntryStore";
import { postJson, postJsonVoid, type CheckedFetch } from "../sync/httpJson";
import {
  buildWorkIntervalStopRequest,
  isIntervalRunning,
  openIntervalsToTimeEntries,
} from "../sync/openIntervals";
import type { TimerLinkedItem } from "../sync/timeTracking";

/**
 * 手動タイマー(▶/⏹)と走行中表示 (実績 UX 刷新フェーズ5b、2026-07-23) をまとめたフック
 * (リファクタリング フェーズ2 ⑤、2026-07-25 に App.tsx から移設)。
 *
 * 走行中(実行中)状態は「サーバーの開区間(GET /api/work-logs/open)」を単一の真実とする。
 * ▶/⏹ はローカルの TimeEntry を作らず、POST /api/work-logs/start・/stop を叩く。
 * timeEntryStore は開区間を射影した「走行中キャッシュ」として残す — WeekGrid と
 * RunningTimersIndicator が既存の TimeEntry[] を消費するため、それらを書き換えずに済むよう、
 * 開区間 → TimeEntry[] を openIntervalsToTimeEntries で作って timeEntryStore.replaceAll で
 * 流し込む(下の射影 effect)。これにより MCP など別経路で開始された開区間もポーリングで反映される。
 *
 * **単一走行の制約は無い**: 別々の repo+issue は同時に何本でも走行できる。二重 start は
 * サーバーが no-op(alreadyOpen)にするので UI 側は無条件に叩いてよい。stop も対象の
 * repo+issue だけを止め、他の並走には触れない。
 *
 * 移設時に**絶対に変えていない**依存の張り方(壊すと無駄な再描画やポーリング暴走になる):
 *  - 1秒 tick の依存は「本数」ではなく `runningTimeEntries.length > 0`(0↔非0 の遷移)。
 *  - 射影 (projectedRunning) の依存は plannedStore の **version(安定した数値)**。
 *    plannedStore.getAll() は毎回新配列を返すので依存に入れてはいけない。
 *  - 45秒ポーリングは github 連携済み (me.github) のときだけ。未連携なら開区間は常に空。
 *  - ⏹ が失敗したときは走行中のまま残す(console.warn のみ。次のポーリングか再操作で回復)。
 *
 * 呼び出し位置の制約(App.tsx 側): ⏹ の成功後に work-logs を取り直すため
 * hooks/useWorkLogs.ts の refetch を受け取る = App.tsx では useWorkLogs のあとに呼ぶ。
 * その代わり「実績系 UI を開いた瞬間に開区間も最新化する」1行(移設前は work-logs 取得の
 * effect の中に同居していた)はこのフックの独立した effect にしてある ―― 発火条件
 * [needsActualsData, checkedFetch] は移設前と同一で、work-logs の取得が先・開区間の
 * 取り直しが後、という commit 内の順序も呼び出し順で保たれる。
 */
export interface TimersController {
  /** 走行中の TimeEntry(開区間の射影)。ヘッダーのインジケーター等が消費する */
  runningTimeEntries: TimeEntry[];
  /** 経過表示用の「現在時刻」。走行中が1本以上あるときだけ1秒ごとに進む */
  timerNowMs: number;
  /** ▶ ボタン(PlannedBlockCard / 作業キュー / ヘッダー)から呼ばれる */
  startTimer: (item: TimerLinkedItem) => void;
  /** ⏹ ボタン(PlannedBlockCard / RunningTimersIndicator / 右ペイン)から呼ばれる */
  stopTimer: (linkedItemId: string) => void;
}

/**
 * @param github 連携情報 (me.github)。null の間は 45秒ポーリングをしない(開区間は常に空)
 * @param needsActualsData 実績系 UI が可視か。true になった瞬間に開区間を最新化する
 * @param plannedStore 射影のメタ補完に使う(version で購読し、getAll() は依存に入れない)
 * @param timeEntryStore 射影の書き込み先 = 走行中キャッシュ。⏹ の対象引き当てにも使う
 * @param githubQueue 射影のメタ補完に使う作業キュー(hooks/useGitHubData.ts の githubQueue)
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 * @param refetchWorkLogs ⏹ の確定分を履歴/レポートへ反映するための再取得
 *   (hooks/useWorkLogs.ts の refetch)
 */
export function useTimers({
  github,
  needsActualsData,
  plannedStore,
  timeEntryStore,
  githubQueue,
  checkedFetch,
  refetchWorkLogs,
}: {
  github: GitHubConnectionDTO | null;
  needsActualsData: boolean;
  plannedStore: PlannedStore;
  timeEntryStore: TimeEntryStore;
  githubQueue: GitHubWorkItemDTO[];
  checkedFetch: CheckedFetch;
  refetchWorkLogs: () => Promise<void>;
}): TimersController {
  // 実行中の開区間一覧(サーバー共有)。起動時・実績系 UI を開いたとき・start/stop 後・
  // 45秒ポーリング(github 連携時のみ)で取得する。
  const [openIntervals, setOpenIntervals] = useState<OpenWorkIntervalDTO[]>([]);

  // GET /api/work-logs/open。401/ネットワークエラーは握って現状維持(他の実績経路と同じ
  // 「取りこぼしより安全側」)。ユーザー操作起点でも定期ポーリングからも呼ぶ。
  const refetchOpenIntervals = useCallback(async () => {
    try {
      const res = await checkedFetch("/api/work-logs/open");
      if (!res.ok) return;
      const data = (await res.json()) as OpenWorkIntervalsResponse;
      setOpenIntervals(data.open);
    } catch (err) {
      console.warn("kichijitsu: GET /api/work-logs/open failed", err);
    }
  }, [checkedFetch]);

  // 走行表示が有効な間(= github 連携済み。タイマーは github の issue/PR 前提)だけ 45秒
  // ポーリングする。マウント時に即時1回取得し、以後 45秒間隔。github 未連携なら開区間は
  // 常に空(ポーリングもしない)。MCP など別経路の start/stop もこのポーリングで反映される。
  useEffect(() => {
    if (!github) return;
    void refetchOpenIntervals();
    const id = window.setInterval(() => void refetchOpenIntervals(), 45_000);
    return () => window.clearInterval(id);
  }, [github, refetchOpenIntervals]);

  /** ▶ ボタン(PlannedBlockCard / 作業キュー / ヘッダー)から呼ばれる。サーバーで開区間を開始する */
  const startTimer = useCallback(
    (item: TimerLinkedItem) => {
      // 二重 start はサーバーが no-op(alreadyOpen)にするので押しても害はないが、既に開区間が
      // あると分かっているなら余計な往復を避けて即 return する(走行表示は既に出ている)。
      if (isIntervalRunning(openIntervals, item.repo, item.number)) return;
      postJsonVoid(checkedFetch, "/api/work-logs/start", {
        repo: item.repo,
        issueRef: String(item.number),
        agent: "timer",
      } satisfies WorkIntervalStartRequest)
        .then(() => refetchOpenIntervals())
        .catch((err) => {
          console.warn("kichijitsu: failed to start work interval", err);
        });
    },
    [checkedFetch, openIntervals, refetchOpenIntervals],
  );

  // ヘッダーの走行中インジケーター(RunningTimersIndicator)と、レポートを開いたときの
  // 経過表示に使う「現在時刻」。1秒 tick は走行中エントリが1本以上あるときだけ動かし、
  // 0本になったら setInterval を止める(無駄な再描画をしない、という増分2の完了条件)。
  const runningTimeEntries = useRunningTimeEntries(timeEntryStore);
  const [timerNowMs, setTimerNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (runningTimeEntries.length === 0) return;
    setTimerNowMs(Date.now());
    const id = window.setInterval(() => setTimerNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
    // 依存は「1本以上走行中か」だけでよい: 本数の増減(2件→3件等)では張り直さず、
    // 0↔非0 の遷移でだけ interval を開始/停止する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningTimeEntries.length > 0]);

  // 開区間 → 走行中 TimeEntry[] の射影(フェーズ5b)。開区間には title/url/type が無いので、
  // 作業キュー(githubQueue)と予定タイムブロックから repo+number でメタを補完する。
  // plannedStore.getAll() は毎回新配列を返すため、useMemo は version(安定した数値)で張って
  // 無駄な再計算を避ける。射影を timeEntryStore.replaceAll へ流し込むと WeekGrid /
  // RunningTimersIndicator / 右ペイン / レポートが既存のまま走行表示を得る。
  const plannedVersion = useSyncExternalStore(plannedStore.subscribe, plannedStore.getVersion);
  const projectedRunning = useMemo(
    () => openIntervalsToTimeEntries(openIntervals, plannedStore.getAll(), githubQueue),
    // plannedVersion で plannedStore.getAll() の内容変化を検知する(getAll 自体は依存に入れない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openIntervals, githubQueue, plannedVersion],
  );
  useEffect(() => {
    // replaceAll は内容が完全一致なら通知しない(45秒ポーリングの空振りで再描画しない)
    timeEntryStore.replaceAll(projectedRunning);
  }, [projectedRunning, timeEntryStore]);

  // 実績系 UI を開いた瞬間に開区間も最新化する(45秒ポーリング待ちで最大45秒古いのを防ぐ)。
  // 移設前は work-logs 取得の effect(現 hooks/useWorkLogs.ts)の中に同居していた1行だが、
  // 発火条件が同じ [needsActualsData, checkedFetch] なので分けても挙動は変わらない
  // (refetchOpenIntervals の identity は checkedFetch にしか依存しない)。
  useEffect(() => {
    if (!needsActualsData) return;
    void refetchOpenIntervals();
  }, [needsActualsData, refetchOpenIntervals]);

  // ⏹ ボタン(WeekGrid の PlannedBlockCard / ヘッダーの RunningTimersIndicator / 右ペイン)から
  // 呼ばれる。対象 linkedItemId の開区間だけをサーバーで停止する(フェーズ5b、2026-07-23)。
  //   1. 走行中キャッシュ(timeEntryStore=開区間の射影)から linkedItemId で該当エントリを引き、
  //      その id で元の開区間を特定して repo+issueRef を得る(開区間側が単一の真実。
  //      引き当てとフォールバックは sync/openIntervals.ts の buildWorkIntervalStopRequest)。
  //   2. POST /api/work-logs/stop で確定。サーバーが work_logs に end を書き、開区間から外れる。
  //   3. 成功後に開区間を再取得(走行解除)し、確定分を反映するため work-logs も再取得する。
  // 対応する開始が無い({closed:false, reason:"no_open_interval"})= 既に停止/孤立。警告のみ
  // 出し、UI は開区間の再取得で整合させる(走行解除)。失敗時も console.warn に留める(次の
  // ポーリングか再操作で回復できる、他の実績経路と同じ「実害の少ない」握り方)。他の並走には触れない。
  const stopTimer = useCallback(
    (linkedItemId: string) => {
      const running = timeEntryStore
        .getRunningEntries()
        .find((e) => e.linkedItemId === linkedItemId);
      if (!running) return;
      postJson<WorkIntervalStopRequest, WorkIntervalStopResponse>(
        checkedFetch,
        "/api/work-logs/stop",
        buildWorkIntervalStopRequest(openIntervals, running),
      )
        .then(async (data) => {
          if (!data.closed) {
            console.warn(
              "kichijitsu: stop had no open interval (already stopped/orphan)",
              data.reason,
            );
          }
          // 走行解除(開区間再取得)+ 確定分を履歴/レポートへ反映(work-logs 再取得)。
          await refetchOpenIntervals();
          await refetchWorkLogs();
        })
        .catch((err) => {
          console.warn("kichijitsu: failed to stop work interval", err);
        });
    },
    [checkedFetch, timeEntryStore, openIntervals, refetchOpenIntervals, refetchWorkLogs],
  );

  return { runningTimeEntries, timerNowMs, startTimer, stopTimer };
}
