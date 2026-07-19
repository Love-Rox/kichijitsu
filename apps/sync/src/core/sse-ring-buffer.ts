import type { ServerEvent } from '@kichijitsu/shared'

export interface BufferedEvent {
  /** 単調増加する SSE の id フィールド。DO インスタンス生存中のみ有効 (再起動でリセットされる)。 */
  id: number
  event: ServerEvent
}

const DEFAULT_CAPACITY = 200

/**
 * ProfileHubDO が保持する直近イベントのリングバッファ。DO storage ではなくメモリで
 * 保持する (= DO 再起動で消えるのは許容)。理由: 再起動でバッファが空になっても、
 * クライアントは再接続時に受け取る `hello` をきっかけに選択中カレンダーを一巡 sync する
 * 仕様にしているため、通知の取りこぼしは「余分な sync が1回走る」程度で実害が無い。
 * バッファはあくまで「hello を待たずに済む」高速パスの最適化。
 */
export class SseRingBuffer {
  private readonly items: BufferedEvent[] = []
  private nextId = 1
  private readonly capacity: number

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity
  }

  push(event: ServerEvent): BufferedEvent {
    const buffered: BufferedEvent = { id: this.nextId, event }
    this.nextId += 1
    this.items.push(buffered)
    if (this.items.length > this.capacity) {
      this.items.shift()
    }
    return buffered
  }

  /**
   * `lastEventId` より新しいイベントを古い順に返す。`lastEventId` がバッファの先頭より
   * さらに古い (＝取りこぼしが確定している) 場合でも、例外を投げず持っている範囲だけを
   * ベストエフォートで返す。取りこぼし自体は `hello` 起点の全選択カレンダー再同期で
   * クライアント側が回復する前提なので、ここでは何も特別扱いしない。
   */
  since(lastEventId: number): BufferedEvent[] {
    return this.items.filter((item) => item.id > lastEventId)
  }
}
