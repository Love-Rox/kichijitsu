import { useSyncExternalStore } from 'react'
import type { AllDayOccurrence } from '../model/types'

/**
 * 終日予定 (フェーズ5) の読み口。OccurrenceStore と同じ API 形状
 * (load/update/remove/get/getRange/subscribe/getVersion) に揃えてあるが、
 * こちらは epoch ms ではなく ISO calendar date 文字列 (YYYY-MM-DD) で
 * 範囲判定する — この形式は文字列の辞書順比較がそのまま日付順比較になるため、
 * Temporal を介さず単純な文字列比較で済む。
 *
 * 終日予定は展開ウィンドウの概念が無い(繰り返しの展開が初版未対応で、
 * 素直に全件が実データ)ため、起動時に全件を load() する運用を想定する。
 */
export class AllDayStore {
  private byId = new Map<string, AllDayOccurrence>()
  private listeners = new Set<() => void>()
  private version = 0
  private rangeCache = new Map<string, { version: number; result: AllDayOccurrence[] }>()

  load(items: Iterable<AllDayOccurrence>): void {
    for (const o of items) this.byId.set(o.id, o)
    this.bump()
  }

  update(item: AllDayOccurrence): void {
    this.byId.set(item.id, item)
    this.bump()
  }

  /** id 指定で終日予定を取り除く(load() は追加専用のため、削除は明示的にこちらで行う) */
  remove(ids: Iterable<string>): void {
    let changed = false
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true
    }
    if (changed) this.bump()
  }

  get(id: string): AllDayOccurrence | undefined {
    return this.byId.get(id)
  }

  /** [fromDate, toDate] (両端 inclusive、YYYY-MM-DD) に重なる終日予定を開始日順で返す */
  getRange(fromDate: string, toDate: string): AllDayOccurrence[] {
    const key = `${fromDate}:${toDate}`
    const hit = this.rangeCache.get(key)
    if (hit && hit.version === this.version) return hit.result
    const result = [...this.byId.values()]
      .filter((o) => o.startDate <= toDate && o.endDate >= fromDate)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
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
    for (const l of this.listeners) l()
  }
}

/** 範囲購読フック。store の更新で再レンダーされ、getRange のキャッシュ済み配列を返す */
export function useAllDayOccurrences(
  store: AllDayStore,
  fromDate: string,
  toDate: string,
): AllDayOccurrence[] {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getRange(fromDate, toDate)
}
