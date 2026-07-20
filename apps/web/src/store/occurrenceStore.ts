import { useSyncExternalStore } from "react";
import type { Occurrence } from "../model/types";

/**
 * UI が読む唯一のデータ源。フェーズ2で中身を IndexedDB レプリカに
 * 差し替える前提のため、読み口 (getRange / useOccurrences) は
 * ここで固定しておく。
 */
export class OccurrenceStore {
  private byId = new Map<string, Occurrence>();
  private listeners = new Set<() => void>();
  private version = 0;
  private rangeCache = new Map<string, { version: number; result: Occurrence[] }>();
  private batchDepth = 0;
  private pendingNotify = false;

  /**
   * fn の実行中に発生する複数回の bump() を1回の listener 通知にまとめる。
   * remove() → load() のような「一時的にデータが空になる」2段階更新の間に
   * 空フレームが描画されるチラつきを防ぐのが目的 (全同期・週移動・展開のやり直し等)。
   *
   * ネスト対応: 呼び出し中に batch() がさらにネストされても、depth が 0 に
   * 戻った最外周の呼び出しでだけ通知する。fn は async でもよく、完了 (resolve/reject
   * いずれでも) を待ってから depth を戻す。version 自体は抑止中も通常どおり
   * 上げるため、flush 後に getRange を呼べば必ず最新状態を返す。
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

  load(occurrences: Iterable<Occurrence>): void {
    for (const o of occurrences) this.byId.set(o.id, o);
    this.bump();
  }

  update(occ: Occurrence): void {
    this.byId.set(occ.id, occ);
    this.bump();
  }

  /**
   * id 指定で occurrence を取り除く。load() は追加専用(既存 id の再 put はできても
   * 消えたものは消せない)ため、IndexedDB 側で削除した occurrence
   * (sync の isFullSync 差し替え・カレンダー選択解除・イベントの cancelled 等)を
   * store からも確実に消すにはこちらを呼ぶ必要がある。
   */
  remove(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true;
    }
    if (changed) this.bump();
  }

  get(id: string): Occurrence | undefined {
    return this.byId.get(id);
  }

  /**
   * 全件(予定 vs 実績レポートの hook 実績集計用、docs/mcp.md「エージェントの作業時間記録」)。
   * getRange と違い表示範囲を問わず、現在ロード済みの(=展開済みウィンドウ内の) 全 occurrence を
   * 対象にする。PlannedStore.getAll/TimeEntryStore.getAll と同じくキャッシュ無し
   * (呼び出しごとに新しい配列)。展開ウィンドウは初回 now±1年 (windowPolicy.ts) なので、
   * hook 実績のような直近の作業記録を取りこぼす実用上の懸念は小さい。
   */
  getAll(): Occurrence[] {
    return [...this.byId.values()];
  }

  /** [startMs, endMs) に重なる occurrence を開始時刻順で返す。結果は version 単位でキャッシュ */
  getRange(startMs: number, endMs: number): Occurrence[] {
    const key = `${startMs}:${endMs}`;
    const hit = this.rangeCache.get(key);
    if (hit && hit.version === this.version) return hit.result;
    const result = [...this.byId.values()]
      .filter((o) => o.startMs < endMs && o.endMs > startMs)
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
export function useOccurrences(
  store: OccurrenceStore,
  startMs: number,
  endMs: number,
): Occurrence[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getRange(startMs, endMs);
}

/**
 * 全件購読フック(予定 vs 実績レポートの hook 実績集計用)。useOccurrences(範囲絞り込み、
 * WeekGrid 等が使う)とは別に、TimeReportOverlay が表示中の週/月に関係なく
 * 展開済み全 occurrence から「kichijitsu 実績」由来のものを拾うために用意する。
 * useAllPlannedBlocks/useTimeEntries と同じ形。
 */
export function useAllOccurrences(store: OccurrenceStore): Occurrence[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getAll();
}
