import { useSyncExternalStore } from 'react'
import type { TaskItem } from '../model/types'

/**
 * Google タスク (docs/google-tasks.md) の読み口。AllDayStore と全く同じ API 形状
 * (load/update/remove/get/getRange/subscribe/getVersion/batch) に揃えてある。
 *
 * タスクも終日予定と同様に展開ウィンドウの概念が無い(due は日付精度のみ・
 * 繰り返しも持たない)ため、起動時に全件を load() する運用を想定する。
 * dueDate が null (期限なし) のタスクは v1 では日付レーンに表示しないため、
 * getRange は dueDate !== null のものだけを対象にする。
 */
export class TaskStore {
  private byId = new Map<string, TaskItem>()
  private listeners = new Set<() => void>()
  private version = 0
  private rangeCache = new Map<string, { version: number; result: TaskItem[] }>()
  private batchDepth = 0
  private pendingNotify = false

  /**
   * fn の実行中に発生する複数回の bump() を1回の listener 通知にまとめる。
   * AllDayStore.batch() / OccurrenceStore.batch() と同じ設計。
   */
  async batch(fn: () => void | Promise<void>): Promise<void> {
    this.batchDepth++
    try {
      await fn()
    } finally {
      this.batchDepth--
      if (this.batchDepth === 0 && this.pendingNotify) {
        this.pendingNotify = false
        this.notify()
      }
    }
  }

  load(items: Iterable<TaskItem>): void {
    for (const t of items) this.byId.set(t.id, t)
    this.bump()
  }

  update(item: TaskItem): void {
    this.byId.set(item.id, item)
    this.bump()
  }

  /** id 指定でタスクを取り除く(load() は追加専用のため、削除は明示的にこちらで行う) */
  remove(ids: Iterable<string>): void {
    let changed = false
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true
    }
    if (changed) this.bump()
  }

  get(id: string): TaskItem | undefined {
    return this.byId.get(id)
  }

  /** [fromDate, toDate] (両端 inclusive、YYYY-MM-DD) が due のタスクを日付順で返す。due 無しは含まない */
  getRange(fromDate: string, toDate: string): TaskItem[] {
    const key = `${fromDate}:${toDate}`
    const hit = this.rangeCache.get(key)
    if (hit && hit.version === this.version) return hit.result
    const result = [...this.byId.values()]
      .filter((t) => t.dueDate !== null && t.dueDate >= fromDate && t.dueDate <= toDate)
      .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string) || a.title.localeCompare(b.title))
    this.rangeCache.set(key, { version: this.version, result })
    return result
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  private bump(): void {
    this.version++
    if (this.batchDepth > 0) {
      this.pendingNotify = true
      return
    }
    this.notify()
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }
}

/** 範囲購読フック。store の更新で再レンダーされ、getRange のキャッシュ済み配列を返す */
export function useTasks(store: TaskStore, fromDate: string, toDate: string): TaskItem[] {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getRange(fromDate, toDate)
}
