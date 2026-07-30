import { useCallback, useEffect, useRef, useState } from "react";
import type { IDBPDatabase } from "idb";
import type { EventCreateResponse, RsvpResponseStatus } from "@kichijitsu/shared";
import {
  deleteAllDayOccurrencesByIds,
  deleteOccurrencesByIds,
  deleteOverridesByIds,
  getOverride,
  getSeries,
  putAllDayOccurrences,
  putOccurrence,
  putOverride,
  putSeries,
  putTask,
  type KichijitsuDB,
} from "../db/database";
import { reexpandCurrentWindow } from "../expansion/ensureExpanded";
import type { AllDayOccurrence, Occurrence, TaskItem } from "../model/types";
import type { AllDayStore } from "../store/allDayStore";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { TaskStore } from "../store/taskStore";
import {
  buildDuplicateDraft,
  buildEventCreateRequest,
  buildPendingAllDayOccurrence,
  buildPendingOccurrence,
  duplicateWriteTarget,
  finalizeCreatedAllDayOccurrence,
  finalizeCreatedOccurrence,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "../sync/eventCreate";
import {
  applyDraftToAllDayOccurrence,
  applyDraftToOccurrence,
  buildEventEditPatchRequest,
  subjectTimeRange,
  type EventEditDraft,
} from "../sync/eventEdit";
import { buildEventDeleteRequest } from "../sync/eventPatch";
import { buildEventRsvpRequest, RsvpNotAttendeeError } from "../sync/eventRsvp";
import {
  applyGuestChangesLocally,
  buildEventGuestsRequest,
  GuestNotOrganizerError,
  type GuestChange,
} from "../sync/eventGuests";
import { jsonInit, sendJson, type CheckedFetch } from "../sync/httpJson";
import { buildTaskPatchRequest } from "../sync/mapTasks";
import { mergeOverridePatch, resolveOverrideRef } from "../sync/overridePatch";
import {
  applyScopeAllToSeries,
  availableRecurrenceScopes,
  buildScopedEventPatchRequest,
  DEFAULT_RECURRENCE_SCOPE,
  EditScopeCancelledError,
  isSeriesInstance,
  type RecurrenceScope,
} from "../sync/recurrenceScope";

/**
 * 予定・タスクの「変更系」をまとめたフック(リファクタリング フェーズ2 ④、2026-07-25)。
 * App.tsx から state・ハンドラをそのまま持ってきたもので、扱う経路は6本:
 *
 *  1. **ドラッグ/リサイズの確定** (persist): 楽観的更新済みの store に合わせて IndexedDB を
 *     書き、Google へ POST /api/event/patch。失敗でロールバック。
 *  2. **新規作成** (createEvent): 仮 id で楽観表示 → POST /api/event/create → 確定 id へ差し替え。
 *     Option(Alt)+ドラッグの**複製** (duplicateEvent、2026-07-29) もこの経路に相乗りする
 *     ―― 複製元の内容を draft に写して createEvent を呼ぶだけの薄い包み。
 *  3. **削除** (deleteOccurrence): 楽観的に消す → POST /api/event/delete → 失敗で復元。
 *  4. **編集フォーム保存** (saveEdit) と **RSVP** (rsvp): 「保存ボタン方式」なので楽観更新はせず、
 *     成功して初めて store/IndexedDB へ反映する(= ロールバック経路が無い)。
 *  5. **移動確認ダイアログ** (moveConfirm / requestMoveConfirm / confirmMove / cancelMove):
 *     store.update だけ済んだ「確定保留」状態を持ち、確認結果に応じて 1 を呼ぶ/store を戻す。
 *  6. **タスクの完了トグル** (toggleTask): 1 と同じ流儀 (楽観 → POST /api/task/patch → 失敗で戻す)。
 *
 * ここに一緒に入れてあるもの:
 *  - **保存エラーのフラッシュ表示** (saveError / flashSaveError)。純粋な表示 state だが、
 *    立てるのは 1・2・3・6 のロールバック経路だけなので変更系と同居させるのが素直。
 *  - **override の patch マージ**は sync/overridePatch.ts の純関数 (resolveOverrideRef /
 *    mergeOverridePatch) に出してテストで固めた ―― 既存 patch を丸ごと置き換えると
 *    conferenceUrl 等が消える実バグを踏んだ箇所なので、判定と合成だけは型と単体テストで守る。
 *  - **繰り返し予定の適用範囲** (2026-07-30、「この予定のみ / すべての予定」)。1 と 4 の
 *    両方に乗る横断的な関心事で、**どの event id をどの時刻で patch するか**の判断は
 *    まるごと sync/recurrenceScope.ts の純関数に出してある(そちらのモジュール冒頭に、
 *    Google Calendar API 側の事情と「これ以降」を提供しない理由を書いた)。このフックが
 *    持つのは「どちらに書くか」の配線だけ:
 *      - **この予定のみ** = 従来どおり InstanceOverride + インスタンス ID への patch。
 *      - **すべての予定** = series レコードを書き換えて reexpandCurrentWindow で再展開し、
 *        親 (シリーズ) の event id へ patch。楽観表示・ロールバックとも series 1件の
 *        入れ替えで完結するので、occurrence を1件ずつ巻き戻す必要がない。
 *
 * 呼び出し位置の制約: このフックが登録する effect は saveErrorTimeoutRef の
 * アンマウント時クリアだけ(依存 [] )なので、App.tsx 内での呼び出し位置は移設前に
 * flashSaveError があった場所(SSE/自動同期の effect 群のあと、実績系 effect 群の前)に
 * 揃えてある。
 */
export interface EventMutationsController {
  /** ロールバックした旨のフラッシュ表示 (ツールバーの「保存失敗（元に戻しました）」) */
  saveError: boolean;
  /**
   * WeekGrid のドラッグ/リサイズ確定 (onPersist)。previous はロールバック用スナップショット。
   * scope は繰り返し予定の適用範囲 (2026-07-30) — 省略時は従来どおり「この予定のみ」。
   */
  persist: (
    updated: Occurrence,
    previous: Occurrence | undefined,
    scope?: RecurrenceScope,
  ) => void;
  /**
   * 空き領域クリック/ドラッグからの新規作成 (onCreateEvent)。draft は速い経路
   * (タイトルだけ) も詳細フォーム (全項目) も同じ形 (2026-07-29 全項目入力)。
   */
  createEvent: (draft: EventCreateDraft, target: WriteTargetCandidate) => void;
  /**
   * Option(Alt)+ドラッグでの複製 (onDuplicate、2026-07-29)。元の予定はそのまま残し、
   * ドロップ先の時間帯へ同じ内容の**新しい予定**を作る ―― 中身は createEvent そのもの。
   */
  duplicateEvent: (source: Occurrence, startMs: number, endMs: number) => void;
  /** 詳細ポップオーバーの削除ボタン (onDelete) */
  deleteOccurrence: (occurrence: Occurrence) => void;
  /**
   * ドラッグ移動の確認待ち。null 以外なら MoveConfirmDialog を出す。
   * scopes は繰り返し予定の適用範囲の選択肢 (2026-07-30) — **空配列なら繰り返しでない
   * 予定**で、ダイアログは 2026-07-30 以前と同じ「移動しますか?」だけになる。
   */
  moveConfirm: {
    updated: Occurrence;
    previous: Occurrence;
    scopes: readonly RecurrenceScope[];
  } | null;
  /** WeekGrid.handleCommit が kind==='move' で時刻が変わったときだけ呼ぶ (onRequestMoveConfirm) */
  requestMoveConfirm: (updated: Occurrence, previous: Occurrence) => void;
  /** ダイアログ「移動する」。選ばれた適用範囲つきで persist に流す */
  confirmMove: (scope: RecurrenceScope) => void;
  /** ダイアログ「キャンセル」。store だけ previous に戻す(IndexedDB/Google は未書き込み) */
  cancelMove: () => void;
  /**
   * 編集フォームの保存で「どの予定に適用するか」を訊いている状態 (2026-07-30)。
   * null 以外なら MoveConfirmDialog を適用範囲モードで出す。**繰り返しでない予定では
   * 常に null** のままで、問いかけは一切増えない。
   */
  editScopeConfirm: { title: string; scopes: readonly RecurrenceScope[] } | null;
  /** 適用範囲ダイアログの決定 / キャンセル (saveEdit の await を解く) */
  confirmEditScope: (scope: RecurrenceScope) => void;
  cancelEditScope: () => void;
  /** 編集フォームの保存 (onSaveEdit / onSaveAllDayEdit)。失敗は throw して呼び出し側に委ねる */
  saveEdit: (original: Occurrence | AllDayOccurrence, draft: EventEditDraft) => Promise<void>;
  /** 参加ステータス変更 (onRsvp / onAllDayRsvp)。422 は RsvpNotAttendeeError を throw する */
  rsvp: (subject: Occurrence | AllDayOccurrence, status: RsvpResponseStatus) => Promise<void>;
  /**
   * ゲスト (参加者) の追加・削除 (onEditGuests、2026-07-31)。楽観的に一覧を書き換えてから
   * POST /api/event/guests、失敗で元へ戻して reject する。422 は GuestNotOrganizerError。
   * 導線を出してよいかの判定は sync/eventGuests.ts の canEditGuests (呼び出し側が使う)。
   */
  editGuests: (subject: Occurrence | AllDayOccurrence, change: GuestChange) => Promise<void>;
  /** タスクの完了トグル (onToggleTask)。枡チェックボックスのタップから呼ばれる */
  toggleTask: (task: TaskItem) => void;
}

/**
 * @param db IndexedDB ハンドル。null(未オープン)の間はどのハンドラも何もしない
 *   ―― ただし saveEdit だけは throw する(フォーム側にエラー表示させるため、移設前と同じ)
 * @param store occurrences の読み口。楽観的更新とロールバックの対象
 * @param allDayStore 終日予定の読み口(終日⇔時刻の入れ替え・終日の RSVP で使う)
 * @param taskStore Google タスクの読み口(完了トグルの対象)
 * @param checkedFetch オフライン判定を挟む fetch ラッパー(App.tsx の checkedFetch)
 * @param timeZone 表示タイムゾーン。Google へ送る dateTime/timeZone の組み立てに使う
 */
export function useEventMutations({
  db,
  store,
  allDayStore,
  taskStore,
  checkedFetch,
  timeZone,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  store: OccurrenceStore;
  allDayStore: AllDayStore;
  taskStore: TaskStore;
  checkedFetch: CheckedFetch;
  timeZone: string;
}): EventMutationsController {
  // Google への書き戻し (POST /api/event/patch) 失敗時のロールバック通知
  // (フェーズ5)。syncStatus とは別軸: こちらはドラッグ確定1件ごとの結果
  const [saveError, setSaveError] = useState(false);
  const saveErrorTimeoutRef = useRef<number | undefined>(undefined);
  /**
   * ドラッグ移動の確認ダイアログ(フェーズ2、2026-07-22)。WeekGrid.handleCommit が
   * kind==='move' で実際に時刻が変わったときだけ null から埋める(sync/moveConfirm.ts の
   * hasOccurrenceTimeChanged 参照)。previous はまだ IndexedDB/Google に書き込まれていない
   * (store.update のみ済みの)ロールバック用スナップショット。
   */
  const [moveConfirm, setMoveConfirm] = useState<{
    updated: Occurrence;
    previous: Occurrence;
    scopes: readonly RecurrenceScope[];
  } | null>(null);
  /**
   * 編集フォーム保存時の適用範囲の問いかけ (2026-07-30)。saveEdit が繰り返し予定を
   * 相手にしたときだけ立ち、ダイアログの決定/キャンセルで resolve する Promise を
   * ref に預けておく ―― saveEdit は「保存ボタン方式」で await できるので、
   * EventEditForm 側に新しい配線を足さずに問いかけを挟める。
   */
  const [editScopeConfirm, setEditScopeConfirm] = useState<{
    title: string;
    scopes: readonly RecurrenceScope[];
  } | null>(null);
  const editScopeResolveRef = useRef<((scope: RecurrenceScope | null) => void) | undefined>(
    undefined,
  );

  // 保存失敗の通知を数秒間表示してから消す(ツールバーの同期ステータスの流儀に倣う)
  const flashSaveError = useCallback(() => {
    if (saveErrorTimeoutRef.current !== undefined) {
      window.clearTimeout(saveErrorTimeoutRef.current);
    }
    setSaveError(true);
    saveErrorTimeoutRef.current = window.setTimeout(() => {
      setSaveError(false);
      saveErrorTimeoutRef.current = undefined;
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (saveErrorTimeoutRef.current !== undefined)
        window.clearTimeout(saveErrorTimeoutRef.current);
    };
  }, []);

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
        console.error(
          "kichijitsu: could not build EventPatchRequest, skipping write-back",
          args.subject.id,
        );
        return false;
      }
      try {
        const res = await checkedFetch("/api/event/patch", jsonInit("POST", patchReq));
        if (!res.ok) {
          console.error(
            `kichijitsu: POST /api/event/patch failed (${args.subject.id}): ${res.status}`,
          );
        }
        return res.ok;
      } catch (err) {
        console.error("kichijitsu: POST /api/event/patch failed", err);
        return false;
      }
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
  const persist = useCallback(
    (
      updated: Occurrence,
      previous: Occurrence | undefined,
      scope: RecurrenceScope = DEFAULT_RECURRENCE_SCOPE,
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
        async function runAll() {
          if (!db) return;
          const series = await getSeries(db, seriesId);
          if (!series) {
            // availableRecurrenceScopes が series 不在時に "all" を出さないので通常は来ない
            console.error("kichijitsu: series not found for scope=all", seriesId);
            return;
          }
          const nextSeries = applyScopeAllToSeries({
            series,
            previous: { startMs: previous!.startMs, endMs: previous!.endMs },
            next: { startMs: updated.startMs, endMs: updated.endMs },
          });
          await putSeries(db, nextSeries);
          await reexpandCurrentWindow(db, store);

          if (updated.source !== "google") return;
          const ok = await postScopedPatch({
            subject: updated,
            scope: "all",
            series,
            previous: { startMs: previous!.startMs, endMs: previous!.endMs },
            next: { startMs: updated.startMs, endMs: updated.endMs },
          });
          if (ok) return;

          // ロールバック: 変更前の series を書き戻して再展開する
          await putSeries(db, series);
          await reexpandCurrentWindow(db, store);
          flashSaveError();
        }
        runAll().catch((err) => {
          console.error("kichijitsu: failed to persist series update", err);
        });
        return;
      }

      async function run() {
        if (!db) return;

        // シリーズ由来なら override を書く前に、ロールバック用に「変更前の override」を
        // 覚えておく(元々 override が無かった/別内容だったケースの両方に対応する)
        const overrideRef = resolveOverrideRef(updated);
        const previousOverride = overrideRef
          ? ((await getOverride(db, overrideRef.id)) ?? null)
          : null;

        if (overrideRef) {
          // 既存 patch をスプレッドしてマージする(rsvp と同じ流儀、sync/overridePatch.ts)。
          // 丸ごと置き換えると、mapGoogle が例外インスタンスから写した conferenceUrl /
          // hasConference / responseStatus / isOrganizer / isWorkingLocation や、編集フォームが
          // 書いた title/location/description が消え、再展開でシリーズ側の値に化けてしまう。
          await putOverride(
            db,
            mergeOverridePatch({
              ref: overrideRef,
              existing: previousOverride,
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
        });

        if (ok) return;

        // ロールバック: store・IndexedDB を変更前の状態に戻す
        if (previous) {
          store.update(previous);
          await putOccurrence(db, previous);
        }
        if (overrideRef) {
          if (previousOverride) {
            await putOverride(db, previousOverride);
          } else {
            await deleteOverridesByIds(db, [overrideRef.id]);
          }
        }
        flashSaveError();
      }
      run().catch((err) => {
        console.error("kichijitsu: failed to persist occurrence update", err);
      });
    },
    [db, store, postScopedPatch, flashSaveError],
  );

  // 新規予定の楽観的作成(フェーズ5、2026-07-29 全項目入力に拡張)。DayColumn の
  // 速い経路(ドラッグ→タイトル→Enter)と詳細フォーム(EventEditForm)の両方から、同じ
  // draft の形で呼ばれる。仮 id (local-pending-<uuid>) の occurrence を即座に
  // store/IndexedDB へ入れて表示し、POST /api/event/create で Google へ書き込む。
  // 成功したら仮 occurrence を確定 id (`g:<accountId>:<calendarId>:<eventId>`) の
  // occurrence に差し替える — 以後 SSE/同期で同じ予定が届いても id が一致するため
  // 冪等に上書きされるだけで済み、重複表示は起きない(eventCreate.ts のコメント参照)。
  // 失敗時は仮 occurrence を削除してロールバックし、saveError を表示する。
  //
  // 終日 (draft.isAllDay) は入れ先のストアが occurrenceStore ではなく allDayStore
  // (IndexedDB も occurrences ではなく allDayOccurrences) になる。楽観表示・確定差し替え・
  // ロールバックの3箇所で同じ分岐が要るので、lane という小さな入れ物に**分岐を1箇所へ
  // 閉じ込め**、下の run() は時刻/終日を意識しない形にしてある(saveEdit の終日⇔時刻の
  // 入れ替えと同じ「ストアの選択だけが違う」という捉え方)。
  const createEvent = useCallback(
    (draft: EventCreateDraft, target: WriteTargetCandidate) => {
      if (!db) return;
      const database = db;
      const lane = draft.isAllDay
        ? (() => {
            const pending = buildPendingAllDayOccurrence({ draft, target, timeZone });
            return {
              pendingId: pending.id,
              show: () => allDayStore.update(pending),
              save: () => putAllDayOccurrences(database, [pending]),
              finalize: async (eventId: string) => {
                const finalized = finalizeCreatedAllDayOccurrence(pending, target, eventId);
                await deleteAllDayOccurrencesByIds(database, [pending.id]);
                await putAllDayOccurrences(database, [finalized]);
                await allDayStore.batch(() => {
                  allDayStore.remove([pending.id]);
                  allDayStore.update(finalized);
                });
              },
              rollback: async () => {
                await deleteAllDayOccurrencesByIds(database, [pending.id]);
                allDayStore.remove([pending.id]);
              },
            };
          })()
        : (() => {
            const pending = buildPendingOccurrence({ draft, target });
            return {
              pendingId: pending.id,
              show: () => store.update(pending),
              save: () => putOccurrence(database, pending),
              finalize: async (eventId: string) => {
                const finalized = finalizeCreatedOccurrence(pending, target, eventId);
                await deleteOccurrencesByIds(database, [pending.id]);
                await putOccurrence(database, finalized);
                // remove→update の間の空フレームを1回の通知にまとめる(点滅防止、他の箇所と同じ流儀)
                await store.batch(() => {
                  store.remove([pending.id]);
                  store.update(finalized);
                });
              },
              rollback: async () => {
                await deleteOccurrencesByIds(database, [pending.id]);
                store.remove([pending.id]);
              },
            };
          })();

      // 楽観的表示: 応答を待たずに即座に見た目へ反映する
      lane.show();
      async function run() {
        await lane.save();

        let ok = false;
        let eventId: string | undefined;
        try {
          const res = await checkedFetch(
            "/api/event/create",
            jsonInit("POST", buildEventCreateRequest({ draft, target, timeZone })),
          );
          ok = res.ok;
          if (ok) {
            const data = (await res.json()) as EventCreateResponse;
            eventId = data.eventId;
          } else {
            console.error(
              `kichijitsu: POST /api/event/create failed (${lane.pendingId}): ${res.status}`,
            );
          }
        } catch (err) {
          console.error("kichijitsu: POST /api/event/create failed", err);
        }

        if (ok && eventId) {
          await lane.finalize(eventId);
          return;
        }

        // ロールバック: 仮 occurrence を削除
        await lane.rollback();
        flashSaveError();
      }
      run().catch((err) => {
        console.error("kichijitsu: failed to persist new occurrence", err);
      });
    },
    [db, store, allDayStore, checkedFetch, timeZone, flashSaveError],
  );

  // Option(Alt)+ドラッグでの複製(2026-07-29、ユーザー要望)。
  // **新しい作成経路は作らず**、複製元 + ドロップ先の時間帯を sync/eventCreate.ts の純関数で
  // draft + 書き込み先に落として、そのまま上の createEvent に流すだけ ―― 楽観表示(仮 id →
  // POST → 確定 id)もロールバックも既存の仕組みをそのまま使える。
  //
  // 移動 (persist) と違い、元の予定には一切触れない(store.update も patch もしない)ので
  // 移動確認ダイアログ (MoveConfirmDialog) は挟まない ―― あのダイアログは「うっかり掴んで
  // 予定の時刻を変えてしまった」を取り消すためのもので、元が変わらない複製では意味が無い
  // (増えた予定が不要なら、その予定を削除すればよい)。
  //
  // duplicateWriteTarget が null(ミラー・Busy・非 Google 等)なら何もしない。通常は
  // EventBlock 側が canDuplicateOccurrence で複製ドラッグ自体を始めないため到達しないが、
  // 呼び出し経路が増えたときのための保険として同じ判定をここにも置く。
  const duplicateEvent = useCallback(
    (source: Occurrence, startMs: number, endMs: number) => {
      const target = duplicateWriteTarget(source);
      if (!target) return;
      createEvent(buildDuplicateDraft(source, startMs, endMs), target);
    },
    [createEvent],
  );

  // 予定の楽観的削除(フェーズ5)。EventBlock の詳細ポップオーバーの削除ボタン(2段階確認)
  // から呼ばれる。occurrence を即座に store/IndexedDB から取り除き、シリーズ由来の
  // 1回分なら override (patch: null = EXDATE 相当、model/series.ts 参照) を書いて
  // 再展開後も現れないようにする(v1 の簡易実装: 本来は EXDATE をシリーズ側に足すのが
  // 正だが、既存の override 機構を流用する)。POST /api/event/delete で Google へ
  // 書き戻し、失敗時は occurrence(と override)を復元してロールバックし、saveError を表示する。
  // 成功後に SSE/同期で cancelled が届いても既に消えているため冪等。
  const deleteOccurrence = useCallback(
    (occurrence: Occurrence) => {
      if (!db) return;
      async function run() {
        if (!db) return;

        const overrideRef = resolveOverrideRef(occurrence);
        const previousOverride = overrideRef
          ? ((await getOverride(db, overrideRef.id)) ?? null)
          : null;

        // 楽観的削除: 応答を待たずに即座に見た目から消す
        store.remove([occurrence.id]);
        await deleteOccurrencesByIds(db, [occurrence.id]);
        if (overrideRef) {
          await putOverride(db, { ...overrideRef, patch: null });
        }

        const deleteReq = buildEventDeleteRequest(occurrence);
        let ok = false;
        if (deleteReq) {
          try {
            const res = await checkedFetch("/api/event/delete", jsonInit("POST", deleteReq));
            ok = res.ok;
            if (!ok) {
              console.error(
                `kichijitsu: POST /api/event/delete failed (${occurrence.id}): ${res.status}`,
              );
            }
          } catch (err) {
            console.error("kichijitsu: POST /api/event/delete failed", err);
          }
        } else {
          console.error(
            "kichijitsu: could not build EventDeleteRequest, skipping delete",
            occurrence.id,
          );
        }

        if (ok) return;

        // ロールバック: occurrence と override を復元
        store.update(occurrence);
        await putOccurrence(db, occurrence);
        if (overrideRef) {
          if (previousOverride) {
            await putOverride(db, previousOverride);
          } else {
            await deleteOverridesByIds(db, [overrideRef.id]);
          }
        }
        flashSaveError();
      }
      run().catch((err) => {
        console.error("kichijitsu: failed to delete occurrence", err);
      });
    },
    [db, store, checkedFetch, flashSaveError],
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
      if (!db || !isSeriesInstance(updated)) {
        setMoveConfirm({ updated, previous, scopes: [] });
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
          });
        })
        .catch((err) => {
          // series が引けなくても移動そのものは従来どおりできる (「この予定のみ」)
          console.error("kichijitsu: failed to load series for move confirm", err);
          setMoveConfirm({ updated, previous, scopes: ["this"] });
        });
    },
    [db],
  );

  const confirmMove = useCallback(
    (scope: RecurrenceScope) => {
      if (!moveConfirm) return;
      persist(moveConfirm.updated, moveConfirm.previous, scope);
      setMoveConfirm(null);
    },
    [moveConfirm, persist],
  );

  const cancelMove = useCallback(() => {
    if (moveConfirm) store.update(moveConfirm.previous);
    setMoveConfirm(null);
  }, [moveConfirm, store]);

  // ---- 編集フォーム保存時の適用範囲の問いかけ (2026-07-30) ----
  // ダイアログの決定/キャンセルを、saveEdit が await している Promise の resolve に流す。
  const confirmEditScope = useCallback((scope: RecurrenceScope) => {
    editScopeResolveRef.current?.(scope);
  }, []);
  const cancelEditScope = useCallback(() => {
    editScopeResolveRef.current?.(null);
  }, []);

  // ---- 予定の編集フォーム (フェーズ2、2026-07-22) ----
  // 「保存ボタン方式」(ユーザー決定): ドラッグ確定 (persist) と違い楽観的更新は行わない
  // ―― POST /api/event/patch が成功して初めて store/IndexedDB へ反映する。そのため失敗時の
  // ロールバックは不要で、EventEditForm 側がエラー表示してフォームを開いたまま再試行できる
  // ようにするだけで良い(このハンドラは reject をそのまま投げ返すだけ)。
  //
  // 終日⇔時刻の変換 (isAllDay トグル): 元が Occurrence で draft.isAllDay===true、または
  // 元が AllDayOccurrence で draft.isAllDay===false のとき、occurrenceStore⇔allDayStore
  // (および IndexedDB の occurrences⇔allDayOccurrences ストア)の間で置き換える
  // (id は Google の実 event id に対応する不変のキーなので、ストアを跨いでも同じ id を使う)。
  const saveEdit = useCallback(
    async (original: Occurrence | AllDayOccurrence, draft: EventEditDraft): Promise<void> => {
      if (!db) throw new Error("database not ready");

      // ---- 適用範囲の問いかけ (2026-07-30) ----
      // **繰り返しでない予定では scopes が空配列**になり、ここは丸ごと素通りする
      // (問いかけも series の読み出しも増えない = 従来と全く同じ経路)。
      const previousRange = subjectTimeRange(original, timeZone);
      const nextRange = { startMs: draft.startMs, endMs: draft.endMs };
      const series = isSeriesInstance(original)
        ? ((await getSeries(db, original.seriesId!)) ?? null)
        : null;
      const scopes = availableRecurrenceScopes({
        subject: original,
        series,
        previous: previousRange,
        next: nextRange,
      });
      let scope: RecurrenceScope = DEFAULT_RECURRENCE_SCOPE;
      if (scopes.length > 0) {
        // 選択肢が「この予定のみ」1つきりでも問いかけは出す ―― 繰り返し予定を編集して
        // いるのに、それが1回分だけに効くことを黙っているのが元々の問題だったため。
        const chosen = await new Promise<RecurrenceScope | null>((resolve) => {
          editScopeResolveRef.current = resolve;
          setEditScopeConfirm({ title: draft.title || original.title, scopes });
        });
        editScopeResolveRef.current = undefined;
        setEditScopeConfirm(null);
        if (chosen === null) throw new EditScopeCancelledError();
        scope = chosen;
      }

      const patchReq = buildEventEditPatchRequest(original, draft, timeZone, scope, series);
      if (!patchReq) {
        throw new Error("kichijitsu: could not build edit EventPatchRequest");
      }
      // httpJson の postJson ではなく sendJson + 自前 throw にしてあるのは、
      // このメッセージ(kichijitsu: 接頭辞 + "(edit)")を変えないため
      const res = await sendJson(checkedFetch, "POST", "/api/event/patch", patchReq);
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/patch (edit) failed: ${res.status}`);
      }

      // ---- 「すべての予定」に適用した場合 (2026-07-30) ----
      // 反映先は override ではなく series レコードそのもの。書き換えて再展開すれば、
      // 展開済み occurrence 全体にタイトル/場所/説明と時刻の変更が一貫して行き渡る
      // (persist の scope==='all' と同じ考え方)。ここまで来ている = Google への書き戻しは
      // 成功済みなので、ロールバック経路は要らない (編集フォームは「保存ボタン方式」)。
      if (scope === "all" && series) {
        await putSeries(
          db,
          applyScopeAllToSeries({
            series,
            previous: previousRange,
            next: nextRange,
            fields: {
              title: draft.title,
              location: draft.location,
              description: draft.description,
            },
          }),
        );
        await reexpandCurrentWindow(db, store);
        return;
      }

      const wasAllDay = !("startMs" in original);

      if (draft.isAllDay) {
        const nextAllDay = applyDraftToAllDayOccurrence(original, draft, timeZone);
        if (!wasAllDay) {
          // 時刻予定 → 終日予定: occurrenceStore/IndexedDB から取り除く
          store.remove([original.id]);
          await deleteOccurrencesByIds(db, [original.id]);
        }
        allDayStore.update(nextAllDay);
        await putAllDayOccurrences(db, [nextAllDay]);
        return;
      }

      const nextOcc = applyDraftToOccurrence(original, draft);
      if (wasAllDay) {
        // 終日予定 → 時刻予定: allDayStore/IndexedDB から取り除く
        allDayStore.remove([original.id]);
        await deleteAllDayOccurrencesByIds(db, [original.id]);
      } else {
        // シリーズ由来の1回分: override にも編集内容を書く(persist と同じ流儀。
        // これが無いと再展開のたびにタイトル/場所/説明がシリーズ側の値に巻き戻ってしまう)。
        // 既存 patch はスプレッドしてマージする(rsvp と同じ流儀、sync/overridePatch.ts)
        // ―― 丸ごと置き換えると mapGoogle が例外インスタンスから写した conferenceUrl /
        // hasConference / responseStatus / isOrganizer / isWorkingLocation が消え、Meet の
        // 参加リンクや参加ステータスが再展開後にシリーズ側の値へ化けてしまう。
        // 単発予定 (resolveOverrideRef が undefined) では何もしない。
        const overrideRef = resolveOverrideRef(original);
        if (overrideRef) {
          const existingOverride = await getOverride(db, overrideRef.id);
          await putOverride(
            db,
            mergeOverridePatch({
              ref: overrideRef,
              existing: existingOverride,
              fields: {
                title: draft.title,
                startMs: draft.startMs,
                endMs: draft.endMs,
                location: draft.location || undefined,
                description: draft.description || undefined,
              },
            }),
          );
        }
      }
      store.update(nextOcc);
      await putOccurrence(db, nextOcc);
    },
    [db, store, allDayStore, checkedFetch, timeZone],
  );

  // ---- RSVP (参加ステータス変更、フェーズ2、2026-07-22) ----
  // 編集フォームと同じ「保存ボタン方式」(押した瞬間に楽観反映はしない、await 完了後に反映)。
  // 422 (not_an_attendee) は RsvpNotAttendeeError を reject することで、呼び出し側
  // (EventBlock.tsx の RsvpButtons)が専用メッセージを出し分けられるようにする。
  const rsvp = useCallback(
    async (subject: Occurrence | AllDayOccurrence, status: RsvpResponseStatus): Promise<void> => {
      const req = buildEventRsvpRequest(subject, status);
      if (!req) {
        throw new Error("kichijitsu: could not build EventRsvpRequest");
      }
      // 422 を RsvpNotAttendeeError に振り替える必要があるため、throw する高レベル関数ではなく
      // Response をそのまま受け取る sendJson を使う
      const res = await sendJson(checkedFetch, "POST", "/api/event/rsvp", req);
      if (res.status === 422) {
        throw new RsvpNotAttendeeError();
      }
      if (!res.ok) {
        throw new Error(`kichijitsu: POST /api/event/rsvp failed: ${res.status}`);
      }
      if (!db) return;

      if ("startMs" in subject) {
        const updated: Occurrence = { ...subject, responseStatus: status };
        store.update(updated);
        await putOccurrence(db, updated);
        const overrideRef = resolveOverrideRef(subject);
        if (overrideRef) {
          const existing = await getOverride(db, overrideRef.id);
          await putOverride(
            db,
            mergeOverridePatch({ ref: overrideRef, existing, fields: { responseStatus: status } }),
          );
        }
      } else {
        const updated: AllDayOccurrence = { ...subject, responseStatus: status };
        allDayStore.update(updated);
        await putAllDayOccurrences(db, [updated]);
      }
    },
    [db, store, allDayStore, checkedFetch],
  );

  // ---- ゲスト (参加者) の追加・削除 (2026-07-31) ----
  // **楽観更新 + ロールバック** (persist / deleteOccurrence と同じ流儀。RSVP や編集フォームの
  // 「保存ボタン方式」ではない) ―― 押した瞬間に一覧へ行が増える/消えるのが操作の実感そのもので、
  // 往復を待って初めて動くと「押せていないのでは」と何度も押してしまう (= 招待メールが重なる)。
  //
  // ロールバック時に flashSaveError は使わない: この操作の間はゲスト欄が必ず開いており、
  // 詳細カードの中にインラインで理由 (422 は専用メッセージ) を出すほうが近くて正確なため。
  // reject はそのまま呼び出し側 (EventDetailCard の GuestSection) へ伝える。
  //
  // 送るのは**差分だけ**。attendees 配列そのものは送らない ―― 手元の一覧は50件で打ち切られて
  // いることがあり、全置換すると手元に無い参加者を巻き添えで消してしまう (sync/eventGuests.ts)。
  const editGuests = useCallback(
    async (subject: Occurrence | AllDayOccurrence, change: GuestChange): Promise<void> => {
      const req = buildEventGuestsRequest(subject, change);
      if (!req) {
        throw new Error("kichijitsu: could not build EventGuestsRequest");
      }
      // 楽観表示 (サーバーが行う read-modify-write の予測)。db が未オープンなら
      // 見た目だけ先に動かすことはせず、書き込みだけ行う
      const nextAttendees = applyGuestChangesLocally(subject.attendees, change);
      const isTimed = "startMs" in subject;
      const optimistic = { ...subject, attendees: nextAttendees };
      if (db) {
        if (isTimed) {
          store.update(optimistic as Occurrence);
          await putOccurrence(db, optimistic as Occurrence);
        } else {
          allDayStore.update(optimistic as AllDayOccurrence);
          await putAllDayOccurrences(db, [optimistic as AllDayOccurrence]);
        }
      }

      // 422 を GuestNotOrganizerError に振り替える必要があるため、throw する高レベル関数ではなく
      // Response をそのまま受け取る sendJson を使う (rsvp と同じ)
      const res = await sendJson(checkedFetch, "POST", "/api/event/guests", req);
      if (res.ok) return;

      // ---- ロールバック ----
      if (db) {
        if (isTimed) {
          store.update(subject as Occurrence);
          await putOccurrence(db, subject as Occurrence);
        } else {
          allDayStore.update(subject as AllDayOccurrence);
          await putAllDayOccurrences(db, [subject as AllDayOccurrence]);
        }
      }
      if (res.status === 422) {
        throw new GuestNotOrganizerError();
      }
      throw new Error(`kichijitsu: POST /api/event/guests failed: ${res.status}`);
    },
    [db, store, allDayStore, checkedFetch],
  );

  // タスクの完了トグル(docs/google-tasks.md)。枡チェックボックスのタップから呼ばれる。
  // ドラッグ確定 (persist) と同じ流儀: 楽観的に taskStore/IndexedDB を即座に更新し、
  // POST /api/task/patch で Google へ書き戻す。失敗時は変更前の状態にロールバックし、
  // 既存の saveError 通知を再利用する。正本は次の「同期」で還流する想定
  // (Tasks API には push 通知が無いため、SSE 経由の即時還流は無い)。
  const toggleTask = useCallback(
    (task: TaskItem) => {
      if (!db) return;
      const nextStatus: TaskItem["status"] =
        task.status === "completed" ? "needsAction" : "completed";
      const previous = task;
      const updated: TaskItem = { ...task, status: nextStatus };
      // 楽観的更新: 応答を待たずに即座に見た目(枡の押印)へ反映する
      taskStore.update(updated);
      async function run() {
        if (!db) return;
        await putTask(db, updated);

        const patchReq = buildTaskPatchRequest(updated, nextStatus);
        let ok = false;
        if (patchReq) {
          try {
            const res = await checkedFetch("/api/task/patch", jsonInit("POST", patchReq));
            // レスポンス (TaskPatchResponse) は ok フラグのみで、正本は次回「同期」で還流する想定
            // (buildEventPatchRequest 経由の persist と同じ流儀。ボディは読み捨てる)
            ok = res.ok;
            if (!ok) {
              console.error(
                `kichijitsu: POST /api/task/patch failed (${updated.id}): ${res.status}`,
              );
            }
          } catch (err) {
            console.error("kichijitsu: POST /api/task/patch failed", err);
          }
        } else {
          console.error(
            "kichijitsu: could not build TaskPatchRequest, skipping write-back",
            updated.id,
          );
        }

        if (ok) return;

        // ロールバック: taskStore・IndexedDB を変更前の状態に戻す
        taskStore.update(previous);
        await putTask(db, previous);
        flashSaveError();
      }
      run().catch((err) => {
        console.error("kichijitsu: failed to persist task update", err);
      });
    },
    [db, taskStore, checkedFetch, flashSaveError],
  );

  return {
    saveError,
    persist,
    createEvent,
    duplicateEvent,
    deleteOccurrence,
    moveConfirm,
    requestMoveConfirm,
    confirmMove,
    cancelMove,
    editScopeConfirm,
    confirmEditScope,
    cancelEditScope,
    saveEdit,
    rsvp,
    editGuests,
    toggleTask,
  };
}
