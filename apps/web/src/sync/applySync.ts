import type { IDBPDatabase } from "idb";
import type { SyncResponse } from "@kichijitsu/shared";
import type { KichijitsuDB } from "../db/database";
import {
  deleteAllDayOccurrencesByIds,
  deleteOccurrencesByIds,
  deleteOverridesByIds,
  deleteSeriesByIds,
  getAllAllDayOccurrences,
  getAllOccurrences,
  getAllOverrides,
  getAllSeries,
  getExpansionState,
  getOccurrencesBetween,
  putAllDayOccurrences,
  putOccurrences,
  putOverride,
  putSeries,
} from "../db/database";
import { reexpandCurrentWindow } from "../expansion/ensureExpanded";
import type { OccurrenceStore } from "../store/occurrenceStore";
import type { AllDayStore } from "../store/allDayStore";
import { mapGoogleEvents, type MapGoogleContext, type MappedSync } from "./mapGoogle";

/** deleteGoogleData のフィルタに渡す、削除対象を絞り込むための occurrence/series のキー */
export interface GoogleDataKey {
  accountId?: string;
  calendarId?: string;
}

/**
 * IndexedDB 上の source==='google' な series/overrides/occurrences を削除する。
 * filter を省略すると google 由来のデータを全て削除する(引数無しで全アカウント
 * 分をまとめて消したいケース向け)。マルチアカウント対応(2026-07-19)により、
 * 通常は (accountId, calendarId) で絞り込んだ filter を渡して使う:
 * - 全同期時のローカルレプリカ再構築 (applySyncResponse の isFullSync 分岐、
 *   対象 (accountId, calendarId) のみ)
 * - カレンダーの選択解除 (App.tsx、対象 (accountId, calendarId) のみ)
 * - アカウント単位の連携解除 (App.tsx、対象 accountId の全カレンダー)
 *
 * 戻り値の deletedOccurrenceIds/deletedAllDayIds は、呼び出し側が
 * OccurrenceStore.remove()/AllDayStore.remove() で store からも消すために使う
 * (store.load() は追加専用で削除できないため)。
 */
export async function deleteGoogleData(
  db: IDBPDatabase<KichijitsuDB>,
  filter?: (key: GoogleDataKey) => boolean,
): Promise<{ deletedOccurrenceIds: string[]; deletedAllDayIds: string[] }> {
  const [existingSeries, existingOverrides, existingOccurrences, existingAllDays] =
    await Promise.all([
      getAllSeries(db),
      getAllOverrides(db),
      getAllOccurrences(db),
      getAllAllDayOccurrences(db),
    ]);
  const matches = (accountId?: string, calendarId?: string): boolean =>
    filter ? filter({ accountId, calendarId }) : true;

  const googleSeriesIds = new Set(
    existingSeries
      .filter((s) => s.source === "google" && matches(s.accountId, s.calendarId))
      .map((s) => s.id),
  );
  const googleOverrideIds = existingOverrides
    .filter((o) => googleSeriesIds.has(o.seriesId))
    .map((o) => o.id);
  const googleOccurrenceIds = existingOccurrences
    .filter((o) => o.source === "google" && matches(o.accountId, o.calendarId))
    .map((o) => o.id);
  const googleAllDayIds = existingAllDays
    .filter((o) => o.source === "google" && matches(o.accountId, o.calendarId))
    .map((o) => o.id);

  await Promise.all([
    deleteSeriesByIds(db, [...googleSeriesIds]),
    deleteOverridesByIds(db, googleOverrideIds),
    deleteOccurrencesByIds(db, googleOccurrenceIds),
    deleteAllDayOccurrencesByIds(db, googleAllDayIds),
  ]);

  return { deletedOccurrenceIds: googleOccurrenceIds, deletedAllDayIds: googleAllDayIds };
}

/**
 * applySyncResponse の isFullSync 分岐用: 対象 (accountId, calendarId) の既存 google
 * データの削除と、mapGoogleEvents が返した新データの put/delete を **単一の
 * readwrite トランザクション**で行う (2026-07-21 修正)。
 *
 * 従来は deleteGoogleData (削除だけの別トランザクション) → putSeries/putOccurrences/
 * putAllDayOccurrences 等 (それぞれ別トランザクション) という並びだったため、削除が
 * 成功した直後に put 側が失敗する(または途中でタブが閉じる等)と、IndexedDB が
 * 「削除だけ済んで空になった」まま残ってしまうリスクがあった。series/overrides/
 * occurrences/allDayOccurrences の4ストアをまとめて1つの tx で開き、削除→put を
 * 同一 tx 上の操作として発行することで、途中で例外が起きれば tx 全体がロールバックされ
 * 「空のまま残る」状態を作らないようにする。
 *
 * 削除と put で同じ id (変更の無かった既存イベントの再投入) が重なる場合、同一ストアへの
 * IDBRequest はキューイング順(= 呼び出し順)で処理されるため、配列の中で削除呼び出しを
 * put 呼び出しより先に並べることで「delete → put」の順序を保証している。
 */
async function applyFullSyncAtomic(
  db: IDBPDatabase<KichijitsuDB>,
  ctx: MapGoogleContext,
  mapped: MappedSync,
): Promise<{ deletedOccurrenceIds: string[]; deletedAllDayIds: string[] }> {
  const tx = db.transaction(
    ["series", "overrides", "occurrences", "allDayOccurrences"],
    "readwrite",
  );
  const seriesStore = tx.objectStore("series");
  const overridesStore = tx.objectStore("overrides");
  const occurrencesStore = tx.objectStore("occurrences");
  const allDayOccurrencesStore = tx.objectStore("allDayOccurrences");

  const [existingSeries, existingOverrides, existingOccurrences, existingAllDays] =
    await Promise.all([
      seriesStore.getAll(),
      overridesStore.getAll(),
      occurrencesStore.getAll(),
      allDayOccurrencesStore.getAll(),
    ]);

  const matchesTarget = (accountId?: string, calendarId?: string): boolean =>
    accountId === ctx.accountId && calendarId === ctx.calendarId;

  const staleSeriesIds = new Set(
    existingSeries
      .filter((s) => s.source === "google" && matchesTarget(s.accountId, s.calendarId))
      .map((s) => s.id),
  );
  const staleOverrideIds = existingOverrides
    .filter((o) => staleSeriesIds.has(o.seriesId))
    .map((o) => o.id);
  const staleOccurrenceIds = existingOccurrences
    .filter((o) => o.source === "google" && matchesTarget(o.accountId, o.calendarId))
    .map((o) => o.id);
  const staleAllDayIds = existingAllDays
    .filter((o) => o.source === "google" && matchesTarget(o.accountId, o.calendarId))
    .map((o) => o.id);

  await Promise.all([
    // 1. 対象 (accountId, calendarId) の既存 google データを削除
    ...[...staleSeriesIds].map((id) => seriesStore.delete(id)),
    ...staleOverrideIds.map((id) => overridesStore.delete(id)),
    ...staleOccurrenceIds.map((id) => occurrencesStore.delete(id)),
    ...staleAllDayIds.map((id) => allDayOccurrencesStore.delete(id)),
    // 2. mapGoogleEvents が返した新データを put/delete (削除と同一 tx なので、同じ id が
    //    両方に現れても上の delete の後に処理される = 最終的に残る)
    ...mapped.series.map((s) => seriesStore.put(s)),
    ...mapped.overrides.map((o) => overridesStore.put(o)),
    ...mapped.singles.map((o) => occurrencesStore.put(o)),
    ...mapped.deletedSingleIds.map((id) => occurrencesStore.delete(id)),
    ...mapped.allDays.map((o) => allDayOccurrencesStore.put(o)),
    ...mapped.deletedAllDayIds.map((id) => allDayOccurrencesStore.delete(id)),
    tx.done,
  ]);

  return {
    deletedOccurrenceIds: [...new Set([...staleOccurrenceIds, ...mapped.deletedSingleIds])],
    deletedAllDayIds: [...new Set([...staleAllDayIds, ...mapped.deletedAllDayIds])],
  };
}

/**
 * apps/sync から受け取った SyncResponse (1つの (accountId, calendarId) ぶん) を
 * IndexedDB に適用し、store に反映する。
 *
 * isFullSync の場合は「この (accountId, calendarId) の」既存 google データだけを
 * 削除してから書き直す(サーバーは差分の起点 = syncToken しか保持しないため、
 * 全同期時はそのカレンダーのローカルレプリカを作り直すのが安全。他カレンダーの
 * データは巻き込まない)。削除と書き直しは applyFullSyncAtomic が単一トランザクションで
 * アトミックに行う(2026-07-21 修正、上記コメント参照)。
 */
export async function applySyncResponse(
  db: IDBPDatabase<KichijitsuDB>,
  store: OccurrenceStore,
  allDayStore: AllDayStore,
  res: SyncResponse,
  ctx: MapGoogleContext,
): Promise<void> {
  // 本体全体を1つのバッチで包み、delete群 → reexpand → 最終 load の間で何度も
  // remove()/load() が呼ばれても listener 通知は最後に1回だけにする。全同期時は
  // google データを全消し→再追加するため、バッチが無いと空フレームが1枚描画されて
  // 大きく点滅する。reexpandCurrentWindow/ensureExpanded も内部で store.batch() を
  // 使うが、depth カウンタでネストしても安全なので二重に囲ってよい
  await store.batch(async () => {
    await allDayStore.batch(async () => {
      const mapped = mapGoogleEvents(res.events, ctx);

      if (res.isFullSync) {
        const { deletedOccurrenceIds, deletedAllDayIds } = await applyFullSyncAtomic(
          db,
          ctx,
          mapped,
        );
        store.remove(deletedOccurrenceIds);
        allDayStore.remove(deletedAllDayIds);
        allDayStore.load(mapped.allDays);
      } else {
        await putSeries(db, mapped.series);
        await Promise.all(mapped.overrides.map((o) => putOverride(db, o)));
        await putOccurrences(db, mapped.singles);
        await deleteOccurrencesByIds(db, mapped.deletedSingleIds);
        store.remove(mapped.deletedSingleIds);

        // 終日予定 (フェーズ5): 展開ウィンドウが無いため単純に put/delete して store に反映するだけでよい
        await putAllDayOccurrences(db, mapped.allDays);
        await deleteAllDayOccurrencesByIds(db, mapped.deletedAllDayIds);
        allDayStore.remove(mapped.deletedAllDayIds);
        allDayStore.load(mapped.allDays);
      }

      // series 定義そのものが変わっている可能性があるため、展開済み範囲を無条件に作り直す
      await reexpandCurrentWindow(db, store);

      const state = await getExpansionState(db);
      if (state) {
        const all = await getOccurrencesBetween(db, state.expandedFromMs, state.expandedToMs);
        store.load(all);
      }
    });
  });
}
