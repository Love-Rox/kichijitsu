import { useSyncExternalStore } from 'react'
import type { Occurrence } from '../model/types'

/**
 * UI が読む唯一のデータ源。フェーズ2で中身を IndexedDB レプリカに
 * 差し替える前提のため、読み口 (getRange / useOccurrences) は
 * ここで固定しておく。
 */
export class OccurrenceStore {
  private byId = new Map<string, Occurrence>()
  private listeners = new Set<() => void>()
  private version = 0
  private rangeCache = new Map<string, { version: number; result: Occurrence[] }>()

  load(occurrences: Iterable<Occurrence>): void {
    for (const o of occurrences) this.byId.set(o.id, o)
    this.bump()
  }

  update(occ: Occurrence): void {
    this.byId.set(occ.id, occ)
    this.bump()
  }

  /**
   * id 指定で occurrence を取り除く。load() は追加専用(既存 id の再 put はできても
   * 消えたものは消せない)ため、IndexedDB 側で削除した occurrence
   * (sync の isFullSync 差し替え・カレンダー選択解除・イベントの cancelled 等)を
   * store からも確実に消すにはこちらを呼ぶ必要がある。
   */
  remove(ids: Iterable<string>): void {
    let changed = false
    for (const id of ids) {
      if (this.byId.delete(id)) changed = true
    }
    if (changed) this.bump()
  }

  get(id: string): Occurrence | undefined {
    return this.byId.get(id)
  }

  /** [startMs, endMs) に重なる occurrence を開始時刻順で返す。結果は version 単位でキャッシュ */
  getRange(startMs: number, endMs: number): Occurrence[] {
    const key = `${startMs}:${endMs}`
    const hit = this.rangeCache.get(key)
    if (hit && hit.version === this.version) return hit.result
    const result = [...this.byId.values()]
      .filter((o) => o.startMs < endMs && o.endMs > startMs)
      .sort((a, b) => a.startMs - b.startMs)
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
export function useOccurrences(
  store: OccurrenceStore,
  startMs: number,
  endMs: number,
): Occurrence[] {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store.getRange(startMs, endMs)
}
