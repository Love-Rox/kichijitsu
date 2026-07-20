import { useSyncExternalStore } from "react";
import type { GitHubItem } from "../model/types";

/**
 * GitHub 連携 (docs/github-integration.md フェーズ①Part B) の読み口。AllDayStore/TaskStore と
 * 全く同じ API 形状 (load/update/remove/get/getRange/subscribe/getVersion/batch) に揃えてある。
 * dateMs が epoch ms である点は Occurrence.startMs と同じため、getRange は
 * OccurrenceStore と同様に [fromMs, toMs) の半開区間で絞り込む(AllDayStore/TaskStore の
 * ISO date 文字列比較とは異なる)。
 *
 * GitHub アイテムも展開ウィンドウの概念が無く、起動時に全件を load() する運用を想定する。
 * サーバーが GitHub アイテムを永続化しないため、GET /api/github/items が返す応答は常に
 * 完全なスナップショット — clear() で全消ししてから load() する「置き換え」運用になる
 * (App.tsx 参照。remove(ids) だけでは消えたアイテムを取りこぼす)。
 */
export class GitHubStore {
  private byId = new Map<string, GitHubItem>();
  private listeners = new Set<() => void>();
  private version = 0;
  private rangeCache = new Map<string, { version: number; result: GitHubItem[] }>();
  private batchDepth = 0;
  private pendingNotify = false;

  /**
   * fn の実行中に発生する複数回の bump() を1回の listener 通知にまとめる。
   * AllDayStore.batch() / TaskStore.batch() と同じ設計。
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

  load(items: Iterable<GitHubItem>): void {
    for (const item of items) this.byId.set(item.id, item);
    this.bump();
  }

  update(item: GitHubItem): void {
    this.byId.set(item.id, item);
    this.bump();
  }

  /** id 指定でアイテムを取り除く(load() は追加専用のため、削除は明示的にこちらで行う) */
  remove(ids: Iterable<string>): void {
    let changed = false;
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true;
    }
    if (changed) this.bump();
  }

  /**
   * 全件を空にする(GET /api/github/items の完全スナップショット置き換え・連携解除用)。
   * remove(ids) と違い対象 id を列挙する必要が無い
   */
  clear(): void {
    if (this.byId.size === 0) return;
    this.byId.clear();
    this.bump();
  }

  get(id: string): GitHubItem | undefined {
    return this.byId.get(id);
  }

  /** [fromMs, toMs) に dateMs が収まるアイテムを日時順で返す */
  getRange(fromMs: number, toMs: number): GitHubItem[] {
    const key = `${fromMs}:${toMs}`;
    const hit = this.rangeCache.get(key);
    if (hit && hit.version === this.version) return hit.result;
    const result = [...this.byId.values()]
      .filter((it) => it.dateMs >= fromMs && it.dateMs < toMs)
      .sort((a, b) => a.dateMs - b.dateMs);
    this.rangeCache.set(key, { version: this.version, result });
    return result;
  }

  /** 全件 snapshot (dateMs 順)。範囲を問わず一覧したい用途向け(設定 UI 等) */
  getAll(): GitHubItem[] {
    return [...this.byId.values()].sort((a, b) => a.dateMs - b.dateMs);
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
export function useGitHubItems(store: GitHubStore, fromMs: number, toMs: number): GitHubItem[] {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getRange(fromMs, toMs);
}
