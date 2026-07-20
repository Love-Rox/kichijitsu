import { useSyncExternalStore } from "react";
import type { TimeEntry } from "../model/types";

/**
 * 手動タイマーの実績エントリ (docs/github-integration.md「時間計測」増分2、2026-07-20) の
 * 読み口。PlannedStore と同じ API 形状 (load/upsert/remove/subscribe/getVersion/batch) に
 * 揃えてあるが、範囲クエリ (getRange) の代わりに全件 (getAll) と走行中エントリの問い合わせ
 * (getRunningEntries/isRunning) を持つ — レポート集計は全件を必要とし、ヘッダー/PlannedBlock の
 * ▶⏹ 判定は「走行中かどうか」だけを必要とするため。
 *
 * **単一走行の制約は無い**(2026-07-20 仕様変更): 別々の linkedItemId は同時に何本でも
 * 走行できる。このストア自身は同一 linkedItemId の二重走行を防ぐわけではない
 * (upsert は id 単位の素朴な上書きのみ)— 「同じ item が既に走行中なら start しない」という
 * 不変条件は呼び出し側 (App.onStartTimer) が isRunning() を見てから upsert する形で担保する。
 *
 * **重要な隔離**: PlannedStore と同様、このストアも Google 同期 (applySync 等) から
 * 一切触られない。▶/⏹ は全てローカルのみ (App.tsx の onStartTimer/onStopTimer がこのストアと
 * IndexedDB の timeEntries ストアだけを更新する。ネットワーク呼び出しは一切無い)。
 */
export class TimeEntryStore {
  private byId = new Map<string, TimeEntry>();
  private listeners = new Set<() => void>();
  private version = 0;
  private batchDepth = 0;
  private pendingNotify = false;

  /**
   * fn の実行中に発生する複数回の bump() を1回の listener 通知にまとめる。
   * PlannedStore.batch() と同じ設計。
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

  load(entries: Iterable<TimeEntry>): void {
    for (const e of entries) this.byId.set(e.id, e);
    this.bump();
  }

  /** 開始(新規作成)・停止(endMs 確定)いずれも同じ経路(id が既存なら上書き) */
  upsert(entry: TimeEntry): void {
    this.byId.set(entry.id, entry);
    this.bump();
  }

  remove(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true;
    }
    if (changed) this.bump();
  }

  get(id: string): TimeEntry | undefined {
    return this.byId.get(id);
  }

  /** 全件(レポート集計用)。呼び出しごとに新しい配列を作る(小規模データ想定のためキャッシュ無し) */
  getAll(): TimeEntry[] {
    return [...this.byId.values()];
  }

  /** 走行中(endMs===null)の全エントリ。ヘッダーインジケーターがこれを列挙する */
  getRunningEntries(): TimeEntry[] {
    return [...this.byId.values()].filter((e) => e.endMs === null);
  }

  /** 指定 linkedItemId に走行中のエントリがあるか(PlannedBlock の ▶/⏹ 切り替え判定に使う) */
  isRunning(linkedItemId: string): boolean {
    for (const e of this.byId.values()) {
      if (e.linkedItemId === linkedItemId && e.endMs === null) return true;
    }
    return false;
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

/** 全件購読フック(レポートオーバーレイ用) */
export function useTimeEntries(store: TimeEntryStore): TimeEntry[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getAll();
}

/** 走行中エントリ購読フック(ヘッダーインジケーター・1秒 tick の起動判定用) */
export function useRunningTimeEntries(store: TimeEntryStore): TimeEntry[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getRunningEntries();
}
