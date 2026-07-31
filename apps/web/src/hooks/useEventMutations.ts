import type { IDBPDatabase } from "idb";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import type { KichijitsuDB } from "../db/database";
import type { AllDayOccurrence, Occurrence, TaskItem } from "../model/types";
import type { AllDayStore } from "../store/allDayStore";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { TaskStore } from "../store/taskStore";
import type { EventCreateDraft, WriteTargetCandidate } from "../sync/eventCreate";
import type { EventEditDraft } from "../sync/eventEdit";
import type { GuestChange } from "../sync/eventGuests";
import type { GuestNotify } from "../sync/guestNotify";
import type { CheckedFetch } from "../sync/httpJson";
import type { RecurrenceScope } from "../sync/recurrenceScope";
import { useAttendeeMutations } from "./mutations/useAttendeeMutations";
import { useCreateEvent } from "./mutations/useCreateEvent";
import { useDeleteOccurrence } from "./mutations/useDeleteOccurrence";
import { useOccurrencePersist } from "./mutations/useOccurrencePersist";
import { useSaveEdit } from "./mutations/useSaveEdit";
import { useSaveErrorFlash } from "./mutations/useSaveErrorFlash";
import { useToggleTask } from "./mutations/useToggleTask";

/**
 * 予定・タスクの「変更系」をまとめたフック(リファクタリング フェーズ2 ④、2026-07-25)。
 * App.tsx から state・ハンドラをそのまま持ってきたもので、扱う経路は6本:
 *
 *  1. **ドラッグ/リサイズの確定** (persist) と**移動確認ダイアログ**
 *     (moveConfirm / requestMoveConfirm / confirmMove / cancelMove)
 *     → mutations/useOccurrencePersist.ts
 *  2. **新規作成** (createEvent) と、その薄い包みである Option(Alt)+ドラッグの**複製**
 *     (duplicateEvent) → mutations/useCreateEvent.ts
 *  3. **削除** (deleteOccurrence) と、ゲストがいるときの**削除確認ダイアログ**
 *     (deleteConfirm / confirmDelete / cancelDelete) → mutations/useDeleteOccurrence.ts
 *  4. **編集フォーム保存** (saveEdit) と**適用範囲/通知の問いかけ**
 *     (editScopeConfirm / confirmEditScope / cancelEditScope) → mutations/useSaveEdit.ts
 *  5. **RSVP** (rsvp) と**ゲストの追加・削除** (editGuests) → mutations/useAttendeeMutations.ts
 *  6. **タスクの完了トグル** (toggleTask) → mutations/useToggleTask.ts
 *
 * このファイル自体は**公開 API の組み立てだけ**を持つ(2026-07-31 の分割)。1035行の
 * 1ファイルに6操作が同居していて、どこまでが1つの操作の手順なのか読み取りづらかったのを、
 * 「ユーザーから見た1操作 + その確認ダイアログ」を単位に切り分けたもの ―― 確認ダイアログは
 * どれも本体の前段/途中でしかなく、切り離すと state の受け渡しが増えるだけで得が無いため、
 * 本体と同じファイルに置いてある。App.tsx から見える形 (下の EventMutationsController) は
 * 分割前と1つも変わっていない。
 *
 * 経路をまたいで共有しているもの:
 *  - **保存エラーのフラッシュ表示** (saveError / flashSaveError、mutations/useSaveErrorFlash.ts)。
 *    立てるのは 1・2・3・6 のロールバック経路だけ。
 *  - **楽観更新の下請け** (mutations/optimisticWrites.ts): 投げっぱなし非同期のログ、
 *    override のスナップショット/復元、時刻・終日でストアを選ぶ書き込み。
 *  - **書き戻し POST の定型** (sync/writeBack.ts): 非 2xx もネットワーク例外も等しく
 *    「失敗 → ロールバック」に倒す判定とログ書式。4経路が同じ12行を写経していたのを1つにした。
 *  - **override の patch マージ**は sync/overridePatch.ts の純関数 (resolveOverrideRef /
 *    mergeOverridePatch)。既存 patch を丸ごと置き換えると conferenceUrl 等が消える実バグを
 *    踏んだ箇所なので、判定と合成だけは型と単体テストで守る。
 *  - **繰り返し予定の適用範囲** (2026-07-30、「この予定のみ / すべての予定」) は 1 と 4 の
 *    両方に乗る横断的な関心事で、**どの event id をどの時刻で patch するか**の判断は
 *    まるごと sync/recurrenceScope.ts の純関数に出してある(そちらのモジュール冒頭に、
 *    Google Calendar API 側の事情と「これ以降」を提供しない理由を書いた)。フック側が
 *    持つのは「どちらに書くか」の配線だけ:
 *      - **この予定のみ** = 従来どおり InstanceOverride + インスタンス ID への patch。
 *      - **すべての予定** = series レコードを書き換えて reexpandCurrentWindow で再展開し、
 *        親 (シリーズ) の event id へ patch。楽観表示・ロールバックとも series 1件の
 *        入れ替えで完結するので、occurrence を1件ずつ巻き戻す必要がない。
 *
 * 呼び出し位置の制約: このフックが登録する effect は saveError タイマーの
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
    notify?: GuestNotify,
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
  /**
   * 詳細ポップオーバーの削除ボタン (onDelete)。**ゲストがいて自分が主催の予定では、
   * ここでは消さずに確認ダイアログ (deleteConfirm) を開く** (2026-07-31) ―― 通知を
   * 送るかどうかを訊いてからでないと sendUpdates が決まらないため。それ以外の予定
   * (削除のほとんど) は 2026-07-31 以前と同じで、その場で楽観的に消しにいく。
   */
  deleteOccurrence: (occurrence: Occurrence) => void;
  /**
   * ゲストのいる予定の削除確認待ち (2026-07-31)。null 以外なら MoveConfirmDialog を
   * purpose='delete' で出す。**ゲストのいない予定・自分が主催でない予定では常に null**
   * のままで、削除は従来どおりポップオーバー内のインライン2段階確認だけで完了する。
   */
  deleteConfirm: { occurrence: Occurrence } | null;
  /** ダイアログ「削除する」。選ばれたゲストへの通知つきで実際の削除に進む */
  confirmDelete: (scope: RecurrenceScope, notify: GuestNotify) => void;
  /** ダイアログ「キャンセル」。何も消さずに閉じるだけ (まだ1件も書き換えていない) */
  cancelDelete: () => void;
  /**
   * ドラッグ移動の確認待ち。null 以外なら MoveConfirmDialog を出す。
   * scopes は繰り返し予定の適用範囲の選択肢 (2026-07-30) — **空配列なら繰り返しでない
   * 予定**で、ダイアログは 2026-07-30 以前と同じ「移動しますか?」だけになる。
   */
  moveConfirm: {
    updated: Occurrence;
    previous: Occurrence;
    scopes: readonly RecurrenceScope[];
    /** ゲストへの通知を訊くか (2026-07-31)。false なら従来どおりダイアログに何も増えない */
    askNotify: boolean;
  } | null;
  /** WeekGrid.handleCommit が kind==='move' で時刻が変わったときだけ呼ぶ (onRequestMoveConfirm) */
  requestMoveConfirm: (updated: Occurrence, previous: Occurrence) => void;
  /** ダイアログ「移動する」。選ばれた適用範囲・ゲストへの通知つきで persist に流す */
  confirmMove: (scope: RecurrenceScope, notify: GuestNotify) => void;
  /** ダイアログ「キャンセル」。store だけ previous に戻す(IndexedDB/Google は未書き込み) */
  cancelMove: () => void;
  /**
   * 編集フォームの保存で「どの予定に適用するか」を訊いている状態 (2026-07-30)。
   * null 以外なら MoveConfirmDialog を適用範囲モードで出す。**繰り返しでない予定では
   * 常に null** のままで、問いかけは一切増えない。
   */
  editScopeConfirm: {
    title: string;
    scopes: readonly RecurrenceScope[];
    /** ゲストへの通知を訊くか (2026-07-31)。繰り返しでない予定でも、ゲストがいれば true */
    askNotify: boolean;
  } | null;
  /** 適用範囲ダイアログの決定 / キャンセル (saveEdit の await を解く) */
  confirmEditScope: (scope: RecurrenceScope, notify: GuestNotify) => void;
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
  // 保存エラーのフラッシュ表示。effect を持つのはこれだけなので、登録順を移設前と
  // 揃えるために必ず最初に呼ぶ
  const { saveError, flashSaveError } = useSaveErrorFlash();

  const { persist, moveConfirm, requestMoveConfirm, confirmMove, cancelMove } =
    useOccurrencePersist({ db, store, checkedFetch, timeZone, flashSaveError });

  const { createEvent, duplicateEvent } = useCreateEvent({
    db,
    store,
    allDayStore,
    checkedFetch,
    timeZone,
    flashSaveError,
  });

  const { deleteOccurrence, deleteConfirm, confirmDelete, cancelDelete } = useDeleteOccurrence({
    db,
    store,
    checkedFetch,
    flashSaveError,
  });

  const { saveEdit, editScopeConfirm, confirmEditScope, cancelEditScope } = useSaveEdit({
    db,
    store,
    allDayStore,
    checkedFetch,
    timeZone,
  });

  const { rsvp, editGuests } = useAttendeeMutations({ db, store, allDayStore, checkedFetch });

  const { toggleTask } = useToggleTask({ db, taskStore, checkedFetch, flashSaveError });

  return {
    saveError,
    persist,
    createEvent,
    duplicateEvent,
    deleteOccurrence,
    deleteConfirm,
    confirmDelete,
    cancelDelete,
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
