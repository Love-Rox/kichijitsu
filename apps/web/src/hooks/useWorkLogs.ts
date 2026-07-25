import { useCallback, useEffect, useState } from "react";
import type {
  WorkLogCreateRequest,
  WorkLogDTO,
  WorkLogsResponse,
  WorkLogUpdateRequest,
} from "@kichijitsu/shared";
import { deleteJson, patchJson, postJsonVoid, type CheckedFetch } from "../sync/httpJson";

/**
 * hook 実績 (work_logs) の一覧 state と、その取得・作成・更新・削除だけを持つフック
 * (リファクタリング フェーズ2 ⑤、2026-07-25 に App.tsx から移設)。
 *
 * docs/mcp.md「エージェントの作業時間記録」の log_work_interval が work_logs テーブルに
 * 保存する値で、2026-07-21 に Google カレンダー保存(occurrences ストア経由)から D1 保存へ
 * 移行した。手動タイマー実績 (TimeEntry、hooks/useTimers.ts)・commit 推定
 * (hooks/useGitHubData.ts) とは別立てのデータなので専用 state で持つ。
 *
 * 書き込み(作成/更新/削除)はいずれも**非楽観更新**: サーバーは {id} しか返さないため、
 * 楽観的にローカルへ1件足すより成功後に一覧を取り直す方が単純、という判断を移設前から
 * 引き継いでいる。失敗時は throw して呼び出し側(フォーム/行ごとの確認 UI)にエラー表示を
 * 委ねる(hooks/useBlockRules.ts と同じ流儀)。
 *
 * 既知の粗さ(今回の移設では**変えていない**): PATCH は 409 `work_log_conflict`(他の実績と
 * 時間が重なる)を返す経路があるが、httpJson の patchJson は非 2xx を一律 Error にするため、
 * ユーザーには汎用のエラー文言しか出ない。文言の作り分けは別途の課題として残してある。
 *
 * 呼び出し位置の制約(App.tsx 側): このフックが登録する effect は「needsActualsData に
 * なったら GET /api/work-logs」1本だけで、hooks/useTimers.ts が持つ effect 群とは
 * 読み書きする state が完全に分かれている(こちらは workLogs のみ、あちらは
 * openIntervals / timerNowMs / timeEntryStore のみ)。移設前は openIntervals の再取得が
 * この effect の中に同居していたので順序が固定されていたが、その1行は useTimers 側の
 * 同条件の effect へ分けた ―― 発火条件は両方 [needsActualsData, checkedFetch] のままで、
 * 「work-logs を先に投げてから開区間を取り直す」という commit 内の順序も、App.tsx が
 * useWorkLogs → useTimers の順で呼ぶことで保たれている。
 */
export interface WorkLogsController {
  /** hook 実績の一覧。needsActualsData の間だけ最新化される(常時ポーリングはしない) */
  workLogs: WorkLogDTO[];
  /** 書き込み成功後の再取得。useTimers の ⏹(停止確定分の反映)からも呼ぶ */
  refetch: () => Promise<void>;
  /** 「実績を手動で追加」フォームから呼ぶ。失敗時は throw する */
  create: (req: WorkLogCreateRequest) => Promise<void>;
  /** 実績履歴のインライン編集から呼ぶ。失敗時は throw する(409 も汎用エラー) */
  update: (id: string, req: WorkLogUpdateRequest) => Promise<void>;
  /** 手動エントリ (agent: manual) の削除ボタンから呼ぶ。失敗時は throw する */
  remove: (id: string) => Promise<void>;
}

/**
 * @param needsActualsData 実績データが実際に見えているか(レポートを開いた、または
 *   右ペインの実績セクションが可視)。false の間は取得しない
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 */
export function useWorkLogs({
  needsActualsData,
  checkedFetch,
}: {
  needsActualsData: boolean;
  checkedFetch: CheckedFetch;
}): WorkLogsController {
  const [workLogs, setWorkLogs] = useState<WorkLogDTO[]>([]);

  // needsActualsData のときだけ GET /api/work-logs を取りに行く(常時ポーリングはしない、
  // POST /api/github/pr-commits の effect と同じ流儀)。401/ネットワークエラーは握って空配列を
  // 返す(レポート表示自体は継続できる、他の実績経路と同じ「取りこぼしより安全側」の方針)
  const fetchWorkLogs = useCallback(async (): Promise<WorkLogDTO[]> => {
    const res = await checkedFetch("/api/work-logs");
    if (!res.ok) return [];
    const data = (await res.json()) as WorkLogsResponse;
    return data.workLogs;
  }, [checkedFetch]);

  useEffect(() => {
    if (!needsActualsData) return;
    let cancelled = false;
    fetchWorkLogs()
      .then((fetched) => {
        if (!cancelled) setWorkLogs(fetched);
      })
      .catch((err) => {
        console.warn("kichijitsu: GET /api/work-logs failed", err);
        if (!cancelled) setWorkLogs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsActualsData, fetchWorkLogs]);

  // 書き込み成功後の再取得に使う(キャンセルガードは持たない — ユーザー操作起点の一回限りの
  // 呼び出しで、上の effect と違って依存の変化で何度も走ることが無いため実害が薄い、
  // useBlockRules の createBlockRule 等と同じ判断)。
  const refetch = useCallback(async () => {
    try {
      setWorkLogs(await fetchWorkLogs());
    } catch (err) {
      console.warn("kichijitsu: GET /api/work-logs (refetch) failed", err);
    }
  }, [fetchWorkLogs]);

  // 「実績を手動で追加」フォームから呼ぶ(2026-07-22)。POST /api/work-logs は
  // POST /api/block-rules 等と同じくセッション cookie 認証。成功後は一覧を再取得して即反映する
  // (サーバーは {id} しか返さないため、楽観的にローカルへ1件追加するより取り直す方が単純)。
  // 失敗時は throw してフォーム側にエラー表示を委ねる(createBlockRule と同じ流儀)。
  const create = useCallback(
    async (req: WorkLogCreateRequest) => {
      await postJsonVoid<WorkLogCreateRequest>(checkedFetch, "/api/work-logs", req);
      await refetch();
    },
    [checkedFetch, refetch],
  );

  // 右ペイン(GitHubPane)実績履歴のインライン編集から呼ぶ(2026-07-23)。PATCH /api/work-logs/:id は
  // create/remove と同じセッション cookie 認証・非楽観更新(成功後に再取得)。失敗時は throw して
  // フォーム側にエラー表示を委ねる(create と同じ流儀)。
  const update = useCallback(
    async (id: string, req: WorkLogUpdateRequest) => {
      await patchJson<WorkLogUpdateRequest>(
        checkedFetch,
        `/api/work-logs/${encodeURIComponent(id)}`,
        req,
      );
      await refetch();
    },
    [checkedFetch, refetch],
  );

  // 実績ログ一覧、手動エントリ(agent: manual)の削除ボタンから呼ぶ(2026-07-22)。204 で成功、
  // 失敗時は throw して一覧側の行ごとの確認 UI にエラー表示を委ねる(deleteBlockRule と同じ流儀)。
  const remove = useCallback(
    async (id: string) => {
      await deleteJson(checkedFetch, `/api/work-logs/${encodeURIComponent(id)}`);
      await refetch();
    },
    [checkedFetch, refetch],
  );

  return { workLogs, refetch, create, update, remove };
}
