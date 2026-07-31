/**
 * 変更系フック (hooks/useEventMutations.ts とその分割先) が共有する、**楽観更新まわりの
 * 小さな下請け**だけを集めた層 (2026-07-31 の分割で切り出し)。
 *
 * ここに置く基準: 「store と IndexedDB を触るが、どの操作 (移動/作成/削除/…) かは知らない」
 * もの。判断らしい判断を含むもの (適用範囲・通知の要否・patch の合成) は sync/ の純関数へ、
 * 操作ごとの手順は mutations/use*.ts へ置く。
 *
 * なぜ切り出したか: 分割前は同じ数行が経路ごとにインラインで書かれていて、
 *  - override のロールバック (「元々無ければ消す / あれば書き戻す」) が移動と削除に2回
 *  - 時刻/終日でストアを選ぶ書き込みが RSVP とゲスト編集に3回
 *  - 投げっぱなし非同期の catch が4回
 * それぞれ写経されていた。ロールバックの取りこぼしは「見た目だけ戻って IndexedDB に
 * 残る」類の分かりにくい壊れ方をするので、形を1つにしておきたい。
 */
import type { IDBPDatabase } from "idb";
import {
  deleteOverridesByIds,
  getOverride,
  putAllDayOccurrences,
  putOccurrence,
  putOverride,
  type KichijitsuDB,
} from "../../db/database";
import type { InstanceOverride } from "../../model/series";
import type { AllDayOccurrence, Occurrence } from "../../model/types";
import type { AllDayStore } from "../../store/allDayStore";
import type { OccurrenceStore } from "../../store/occurrenceStore";
import {
  resolveOverrideRef,
  type OverrideRef,
  type OverrideSubject,
} from "../../sync/overridePatch";

/**
 * 楽観更新の後始末 (IndexedDB 書き込み・書き戻し・ロールバック) を投げっぱなしで走らせる。
 * ハンドラ自身は同期的に返る (React のイベントハンドラなので await できない) 一方で、
 * 想定外の例外を握りつぶすと何も起きていないように見えてしまうため、ログだけは必ず残す。
 */
export function runDetached(message: string, run: () => Promise<void>): void {
  run().catch((err) => {
    console.error(message, err);
  });
}

/** snapshotOverride の戻り。ref があるときだけ override を読み書きする */
export interface OverrideSnapshot {
  /** override の宛先。単発予定なら undefined = override には一切触れない */
  readonly ref: OverrideRef | undefined;
  /** 変更前の override (元々無ければ null)。ロールバックの分岐に使う */
  readonly previous: InstanceOverride | null;
  /** 変更前の状態へ戻す。元々無かったなら書いた override を削除する */
  restore: () => Promise<void>;
}

/**
 * シリーズ由来の1回分を書き換える前に「変更前の override」を控える。
 * 元々 override が無かった場合と別内容だった場合の両方を1つの restore() に閉じ込めてある
 * ―― 分割前は移動 (persist) と削除 (runDelete) が同じ4行の分岐を各々持っていた。
 */
export async function snapshotOverride(
  db: IDBPDatabase<KichijitsuDB>,
  subject: OverrideSubject,
): Promise<OverrideSnapshot> {
  const ref = resolveOverrideRef(subject);
  const previous = ref ? ((await getOverride(db, ref.id)) ?? null) : null;
  return {
    ref,
    previous,
    restore: async () => {
      if (!ref) return;
      if (previous) {
        await putOverride(db, previous);
      } else {
        await deleteOverridesByIds(db, [ref.id]);
      }
    },
  };
}

/** 時刻予定と終日予定でストアが分かれるので、書き込み先の2つをまとめて渡すための入れ物 */
export interface OccurrenceStores {
  store: OccurrenceStore;
  allDayStore: AllDayStore;
}

/**
 * 予定1件を store (見た目) と IndexedDB (手元の正本) の両方へ書く。時刻予定か終日予定かで
 * 入れ先が occurrenceStore/occurrences と allDayStore/allDayOccurrences に分かれるだけの
 * 違いをここに閉じ込める ―― RSVP とゲスト編集が、楽観表示にもロールバックにも同じ形で使う。
 */
export async function writeSubject(
  db: IDBPDatabase<KichijitsuDB>,
  { store, allDayStore }: OccurrenceStores,
  subject: Occurrence | AllDayOccurrence,
): Promise<void> {
  if ("startMs" in subject) {
    store.update(subject);
    await putOccurrence(db, subject);
  } else {
    allDayStore.update(subject);
    await putAllDayOccurrences(db, [subject]);
  }
}
