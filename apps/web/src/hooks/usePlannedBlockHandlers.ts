import { useCallback } from "react";
import type { IDBPDatabase } from "idb";
import { deletePlannedBlock, putPlannedBlock, type KichijitsuDB } from "../db/database";
import type { PlannedBlock } from "../model/types";
import type { PlannedStore } from "../store/plannedStore";
import { buildPlannedBlock, type DroppedWorkItem } from "../sync/planned";

/**
 * 予定タイムブロック (docs/github-integration.md「時間計測」増分1、2026-07-20) の
 * 作成(ドラッグ&ドロップ)/移動・リサイズ/削除ハンドラ
 * (リファクタリング フェーズ2 ⑤、2026-07-25 に App.tsx から移設)。
 *
 * 3つとも全てローカルのみ: plannedStore(メモリ)と IndexedDB の plannedBlocks ストアだけを
 * 更新し、ネットワーク呼び出し(/api/event/* 等)は一切行わない。Google 側の変更系
 * (hooks/useEventMutations.ts) とは意図的に別経路にしてある ―― このブロックは Google に
 * 存在しない、書き戻し先が無いローカル専用の予定のため。
 *
 * effect を一切登録しないので、App.tsx 内での呼び出し位置に制約は無い(それでも移設前と
 * 同じ場所に置いてある)。
 */
export interface PlannedBlockHandlers {
  /** 作業キューの項目がグリッドへドロップされたときに呼ばれる(DayColumn.tsx の onDrop 経由) */
  dropWorkItem: (item: DroppedWorkItem, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの本体ドラッグ(移動)/端ドラッグ(リサイズ)確定時に呼ばれる */
  movePlannedBlock: (id: string, startMs: number, endMs: number) => void;
  /** 予定タイムブロックの削除ボタンから呼ばれる */
  deletePlannedBlock: (id: string) => void;
}

/**
 * @param db IndexedDB ハンドル。null(未オープン)の間はどのハンドラも何もしない
 * @param plannedStore 予定タイムブロックの読み口。楽観的更新の対象(即時反映で確定)
 */
export function usePlannedBlockHandlers({
  db,
  plannedStore,
}: {
  db: IDBPDatabase<KichijitsuDB> | null;
  plannedStore: PlannedStore;
}): PlannedBlockHandlers {
  const dropWorkItem = useCallback(
    (item: DroppedWorkItem, startMs: number, endMs: number) => {
      if (!db) return;
      const block = buildPlannedBlock(item, startMs, endMs);
      // 楽観的表示: ネットワークが絡まないため待つ理由が無く、常に即時反映で確定でよい
      plannedStore.upsert(block);
      putPlannedBlock(db, block).catch((err) => {
        console.error("kichijitsu: failed to persist planned block", err);
      });
    },
    [db, plannedStore],
  );

  const movePlannedBlock = useCallback(
    (id: string, startMs: number, endMs: number) => {
      if (!db) return;
      const existing = plannedStore.get(id);
      if (!existing) return;
      const updated: PlannedBlock = { ...existing, startMs, endMs };
      plannedStore.upsert(updated);
      putPlannedBlock(db, updated).catch((err) => {
        console.error("kichijitsu: failed to persist planned block move", err);
      });
    },
    [db, plannedStore],
  );

  const removePlannedBlock = useCallback(
    (id: string) => {
      if (!db) return;
      plannedStore.remove([id]);
      deletePlannedBlock(db, id).catch((err) => {
        console.error("kichijitsu: failed to delete planned block", err);
      });
    },
    [db, plannedStore],
  );

  return { dropWorkItem, movePlannedBlock, deletePlannedBlock: removePlannedBlock };
}
