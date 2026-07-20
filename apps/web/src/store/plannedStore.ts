import { useSyncExternalStore } from "react";
import type { PlannedBlock } from "../model/types";

/**
 * 予定タイムブロック (docs/github-integration.md「時間計測」増分1、2026-07-20) の読み口。
 * OccurrenceStore/GitHubStore と同じ API 形状 (load/upsert/remove/getRange/subscribe/
 * getVersion/batch) に揃えてある。startMs/endMs は Occurrence と同じ epoch ms なので、
 * getRange は OccurrenceStore と同様に [startMs, endMs) の半開区間の重なり判定で絞り込む。
 *
 * **重要な隔離**: このストアは Google 同期 (applySync 等) から一切触られない。ドラッグでの
 * 新規作成・移動・リサイズ・削除は全てローカルのみ (App.tsx の onDropWorkItem/
 * onMovePlannedBlock/onDeletePlannedBlock がこのストアと IndexedDB の plannedBlocks
 * ストアだけを更新する。ネットワーク呼び出しは一切無い)。
 */
export class PlannedStore {
  private byId = new Map<string, PlannedBlock>();
  private listeners = new Set<() => void>();
  private version = 0;
  private rangeCache = new Map<string, { version: number; result: PlannedBlock[] }>();
  private batchDepth = 0;
  private pendingNotify = false;

  /**
   * fn の実行中に発生する複数回の bump() を1回の listener 通知にまとめる。
   * OccurrenceStore.batch() / GitHubStore.batch() と同じ設計。
   */
  async batch(fn: () => void | Promise<void>): Promise<void> {
    this.batchDepth++;
    try {
      await fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.pendingNotify) {
        this.pendingNotify = false;
        this.notify();
      }
    }
  }

  load(blocks: Iterable<PlannedBlock>): void {
    for (const b of blocks) this.byId.set(b.id, b);
    this.bump();
  }

  /** 新規作成・移動・リサイズいずれも同じ経路(id が既存なら上書き) */
  upsert(block: PlannedBlock): void {
    this.byId.set(block.id, block);
    this.bump();
  }

  /** 削除ボタンから呼ばれる */
  remove(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true;
    }
    if (changed) this.bump();
  }

  get(id: string): PlannedBlock | undefined {
    return this.byId.get(id);
  }

  /**
   * 全件(予定 vs 実績レポート用、docs/github-integration.md「時間計測」増分2)。getRange と違い
   * 表示範囲を問わず全ての予定タイムブロックを対象にする。呼び出しごとに新しい配列を作る
   * (TimeEntryStore.getAll と同じくキャッシュ無し、小規模データ想定のため)。
   */
  getAll(): PlannedBlock[] {
    return [...this.byId.values()];
  }

  /** [startMs, endMs) に重なる予定ブロックを開始時刻順で返す。結果は version 単位でキャッシュ */
  getRange(startMs: number, endMs: number): PlannedBlock[] {
    const key = `${startMs}:${endMs}`;
    const hit = this.rangeCache.get(key);
    if (hit && hit.version === this.version) return hit.result;
    const result = [...this.byId.values()]
      .filter((b) => b.startMs < endMs && b.endMs > startMs)
      .sort((a, b) => a.startMs - b.startMs);
    this.rangeCache.set(key, { version: this.version, result });
    return result;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    if (this.batchDepth > 0) {
      this.pendingNotify = true;
      return;
    }
    this.notify();
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

/** 範囲購読フック。store の更新で再レンダーされ、getRange のキャッシュ済み配列を返す */
export function usePlannedBlocks(
  store: PlannedStore,
  startMs: number,
  endMs: number,
): PlannedBlock[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getRange(startMs, endMs);
}

/**
 * 全件購読フック(予定 vs 実績レポート用、docs/github-integration.md「時間計測」増分2)。
 * usePlannedBlocks(範囲絞り込み、WeekGrid が使う)とは別に、TimeReportOverlay が
 * 表示中の週/月に関係なく全ての予定タイムブロックを必要とするために用意する。
 */
export function useAllPlannedBlocks(store: PlannedStore): PlannedBlock[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getAll();
}
