/**
 * **ドラッグ/リサイズの確定と、その手前の移動確認ダイアログ**を担当する
 * (useEventMutations から分割、2026-07-31)。
 *
 * この2つを1ファイルに置いてあるのは、確認ダイアログが「確定保留の persist」そのものだから
 * ―― requestMoveConfirm で預かった (updated, previous) を confirmMove がそのまま persist へ
 * 流し、cancelMove は store を previous に戻すだけ。間に他の経路は挟まらない。
 *
 * 流儀は「楽観更新 → 書き戻し → 失敗ならロールバック」:
 * store.update は WeekGrid 側で既に同期的に済んでいるので、ここは IndexedDB への書き込みと
 * POST /api/event/patch を行い、失敗したら store と IndexedDB を変更前に戻して
 * saveError をフラッシュ表示する。
 */
import { useCallback, useState } from "react";
import type { IDBPDatabase } from "idb";
import {
  getSeries,
  putOccurrence,
  putOverride,
  putSeries,
  type KichijitsuDB,
} from "../../db/database";
import { reexpandCurrentWindow } from "../../expansion/ensureExpanded";
import type { Occurrence } from "../../model/types";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import { shouldAskGuestNotify, type GuestNotify } from "../../sync/guestNotify";
import type { CheckedFetch } from "../../sync/httpJson";
import { mergeOverridePatch } from "../../sync/overridePatch";
import {
  applyScopeAllToSeries,
  availableRecurrenceScopes,
  buildScopedEventPatchRequest,
  DEFAULT_RECURRENCE_SCOPE,
  isSeriesInstance,
  type RecurrenceScope,
} from "../../sync/recurrenceScope";
import { logSkippedWriteBack, postWriteBack } from "../../sync/writeBack";
import { runDetached, snapshotOverride } from "./optimisticWrites";

/** 移動確認ダイアログの「確定保留」状態 (previous はまだどこにも書き込んでいない) */
export interface MoveConfirmState {
  updated: Occurrence;
  previous: Occurrence;
  scopes: readonly RecurrenceScope[];
  askNotify: boolean;
}

export type PersistOccurrence = (
  updated: Occurrence,
  previous: Occurrence | undefined,
  scope?: RecurrenceScope,
  notify?: GuestNotify,
) => void;

export function useOccurrencePersist({
  db,
  store,
  checkedFetch,
  timeZone,
  flashSaveError,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  checkedFetch: CheckedFetch;
  timeZone: string;
  flashSaveError: () => void;
}): {
  persist: PersistOccurrence;
  moveConfirm: MoveConfirmState | null;
  requestMoveConfirm: (updated: Occurrence, previous: Occurrence) => void;
  confirmMove: (scope: RecurrenceScope, notify: GuestNotify) => void;
  cancelMove: () => void;
} {
  /**
   * ドラッグ移動の確認ダイアログ(フェーズ2、2026-07-22)。WeekGrid.handleCommit が
   * kind==='move' で実際に時刻が変わったときだけ null から埋める(sync/moveConfirm.ts の
   * hasOccurrenceTimeChanged 参照)。previous はまだ IndexedDB/Google に書き込まれていない
   * (store.update のみ済みの)ロールバック用スナップショット。
   */
  const [moveConfirm, setMoveConfirm] = useState<MoveConfirmState | null>(null);

  /**
   * 適用範囲つきの POST /api/event/patch (2026-07-30)。宛先の決定は
   * sync/recurrenceScope.ts の buildScopedEventPatchRequest に任せ、ここは送信と
   * ログだけを持つ。成功したら true。
   *
   * ドラッグ確定 (persist) の「この予定のみ」「すべて」の2経路が共通で通る。
   * 編集フォーム (saveEdit) は失敗を throw して呼び出し側に返す約束なので通らない。
   */
  const postScopedPatch = useCallback(
    async (
      args: Omit<Parameters<typeof buildScopedEventPatchRequest>[0], "timeZone">,
    ): Promise<boolean> => {
      const patchReq = buildScopedEventPatchRequest({ ...args, timeZone });
      if (!patchReq) {
        logSkippedWriteBack("EventPatchRequest", args.subject.id);
        return false;
      }
      const { ok } = await postWriteBack(
        checkedFetch,
        "/api/event/patch",
        patchReq,
        args.subject.id,
      );
      return ok;
    },
    [checkedFetch, timeZone],
  );

  // ドラッグ確定時の永続化(フェーズ5)。store.update は WeekGrid 側で既に同期的に
  // 呼ばれている(楽観的更新)。ここでは IndexedDB への書き込みに加えて、
  // source==='google' な occurrence は POST /api/event/patch で Google へも書き戻す。
  // 書き戻しが失敗した場合(非2xx・ネットワークエラー)は store と IndexedDB を
  // 変更前の状態にロールバックし、ユーザーに数秒間通知する。
  //
  // 書き戻し成功時、正本は次の同期 (SSE changed → /api/sync) で還流してくる想定
  // (protocol.ts の EventPatchRequest コメント参照)。自分自身が書いた変更が
  // 同じ id へそのまま上書きされるだけなので、冪等であり特別な処理は不要。
  const persist = useCallback<PersistOccurrence>(
    (
      updated,
      previous,
      scope = DEFAULT_RECURRENCE_SCOPE,
      /**
       * 確認ダイアログで選ばれたゲストへの通知 (2026-07-31)。訊いていない相手では
       * undefined のまま流してよい ―― buildScopedEventPatchRequest が subject を見て
       * 安全側 (externalOnly) に確定する (sync/guestNotify.ts の resolveSendUpdates)。
       */
      notify,
    ) => {
      if (!db) return;

      // ---- 「すべての予定」に適用する経路 (2026-07-30) ----
      // この予定のみ (override を書く) とは書き込み対象がまるごと違うので、経路を分ける。
      // 楽観表示は **series レコードを書き換えて再展開する** だけで済ませる ―― 展開済み
      // occurrence 全体が一貫して動き、ロールバックも「変更前の series を書き戻して
      // もう一度再展開」で完結する(occurrence を1件ずつ巻き戻す必要がない)。
      // ローカルのみのシリーズ (source!=='google') でも、この局所更新だけで正しく完了する。
      if (scope === "all" && previous && updated.seriesId) {
        const seriesId = updated.seriesId;
        // 変更前後の時間帯。コールバックの中では previous の絞り込みが効かないので先に固める
        const previousRange = { startMs: previous.startMs, endMs: previous.endMs };
        const nextRange = { startMs: updated.startMs, endMs: updated.endMs };
        runDetached("kichijitsu: failed to persist series update", async () => {
          if (!db) return;
          const series = await getSeries(db, seriesId);
          if (!series) {
            // availableRecurrenceScopes が series 不在時に "all" を出さないので通常は来ない
            console.error("kichijitsu: series not found for scope=all", seriesId);
            return;
          }
          const nextSeries = applyScopeAllToSeries({
            series,
            previous: previousRange,
            next: nextRange,
          });
          await putSeries(db, nextSeries);
          await reexpandCurrentWindow(db, store);

          if (updated.source !== "google") return;
          const ok = await postScopedPatch({
            subject: updated,
            scope: "all",
            series,
            previous: previousRange,
            next: nextRange,
            notify,
          });
          if (ok) return;

          // ロールバック: 変更前の series を書き戻して再展開する
          await putSeries(db, series);
          await reexpandCurrentWindow(db, store);
          flashSaveError();
        });
        return;
      }

      runDetached("kichijitsu: failed to persist occurrence update", async () => {
        if (!db) return;

        // シリーズ由来なら override を書く前に、ロールバック用に「変更前の override」を
        // 覚えておく(元々 override が無かった/別内容だったケースの両方に対応する)
        const override = await snapshotOverride(db, updated);

        if (override.ref) {
          // 既存 patch をスプレッドしてマージする(rsvp と同じ流儀、sync/overridePatch.ts)。
          // 丸ごと置き換えると、mapGoogle が例外インスタンスから写した conferenceUrl /
          // hasConference / responseStatus / isOrganizer / isWorkingLocation や、編集フォームが
          // 書いた title/location/description が消え、再展開でシリーズ側の値に化けてしまう。
          await putOverride(
            db,
            mergeOverridePatch({
              ref: override.ref,
              existing: override.previous,
              fields: { startMs: updated.startMs, endMs: updated.endMs },
            }),
          );
        }
        await putOccurrence(db, updated);

        // ローカルのみの occurrence はここまで(Google への書き戻し対象外)
        if (updated.source !== "google") return;

        const ok = await postScopedPatch({
          subject: updated,
          scope: "this",
          next: { startMs: updated.startMs, endMs: updated.endMs },
          notify,
        });

        if (ok) return;

        // ロールバック: store・IndexedDB を変更前の状態に戻す
        if (previous) {
          store.update(previous);
          await putOccurrence(db, previous);
        }
        await override.restore();
        flashSaveError();
      });
    },
    [db, store, postScopedPatch, flashSaveError],
  );

  // ---- ドラッグ移動の確認ダイアログ (フェーズ2、2026-07-22) ----
  // WeekGrid.handleCommit は kind==='move' で実際に時刻が変わったときだけこれを呼ぶ。
  // 呼ばれた時点では store.update(updated) は既に済んでいる(楽観的な見た目の反映)が、
  // persist (IndexedDB 書き込み・Google 書き戻し) はまだ呼ばれていない ―― 「確定保留」
  // 状態を表す moveConfirm state に previous/updated を保持し、確認結果に応じて
  // persist を呼ぶ(移動する)か、store だけ previous に戻す(キャンセル)かを行う。

  // 適用範囲の選択肢 (2026-07-30) を出すために、シリーズ由来なら series レコードを
  // IndexedDB から引いてからダイアログを開く ―― 親の DTSTART が分からないと
  // 「すべて」を安全に提示できない (sync/recurrenceScope.ts の canApplyScopeAll)。
  // 繰り返しでない予定では DB を引かずに即座に開く (従来と同じタイミング)。
  const requestMoveConfirm = useCallback(
    (updated: Occurrence, previous: Occurrence) => {
      // ゲストへの通知を訊くか (2026-07-31)。**ゲストのいない予定・自分が主催でない予定では
      // false** になり、ダイアログは 2026-07-31 以前と1pxも変わらない。
      const askNotify = shouldAskGuestNotify(updated);
      if (!db || !isSeriesInstance(updated)) {
        setMoveConfirm({ updated, previous, scopes: [], askNotify });
        return;
      }
      const seriesId = updated.seriesId!;
      getSeries(db, seriesId)
        .then((series) => {
          setMoveConfirm({
            updated,
            previous,
            scopes: availableRecurrenceScopes({
              subject: updated,
              series,
              previous: { startMs: previous.startMs, endMs: previous.endMs },
              next: { startMs: updated.startMs, endMs: updated.endMs },
            }),
            askNotify,
          });
        })
        .catch((err) => {
          // series が引けなくても移動そのものは従来どおりできる (「この予定のみ」)
          console.error("kichijitsu: failed to load series for move confirm", err);
          setMoveConfirm({ updated, previous, scopes: ["this"], askNotify });
        });
    },
    [db],
  );

  const confirmMove = useCallback(
    (scope: RecurrenceScope, notify: GuestNotify) => {
      if (!moveConfirm) return;
      persist(moveConfirm.updated, moveConfirm.previous, scope, notify);
      setMoveConfirm(null);
    },
    [moveConfirm, persist],
  );

  const cancelMove = useCallback(() => {
    if (moveConfirm) store.update(moveConfirm.previous);
    setMoveConfirm(null);
  }, [moveConfirm, store]);

  return { persist, moveConfirm, requestMoveConfirm, confirmMove, cancelMove };
}
