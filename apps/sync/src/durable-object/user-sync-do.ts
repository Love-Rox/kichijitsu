import { DurableObject } from 'cloudflare:workers'
import type { CalendarListEntryDTO, SyncResponse } from '@kichijitsu/shared'
import { fetchCalendarList } from '../google/calendar-list'
import { refreshAccessToken } from '../google/oauth'
import { hasUpdatesSince } from '../google/poll-check'
import { syncCalendar, type SyncCoreDeps } from '../core/sync'
import { patchEventTimeWithRetry, type PatchEventCoreDeps } from '../core/patch-event'
import { NotConnectedError } from '../core/errors'
import { runRpc, type RpcResult } from '../rpc-result'
import { decryptToken, InvalidCiphertextError } from '../crypto'

// アクセストークンをこの秒数前倒しで期限切れ扱いにし、ギリギリで失効したリクエストを防ぐ。
const TOKEN_EXPIRY_SKEW_SECONDS = 60

// ポーリングフォールバックの間隔 (design: 10分)。SSE 接続が1つでもある profile の
// アカウントに対してのみ動く (ProfileHubDO.enablePolling/disablePolling で開閉する)。
const POLL_INTERVAL_MS = 10 * 60 * 1000

interface TokenCacheRow extends Record<string, SqlStorageValue> {
  access_token: string
  expires_at: number
}

interface SyncTokenRow extends Record<string, SqlStorageValue> {
  sync_token: string | null
}

interface PollingStateRow extends Record<string, SqlStorageValue> {
  account_id: string | null
  profile_id: string | null
  enabled: number
}

interface PollWatermarkRow extends Record<string, SqlStorageValue> {
  since: string
}

/**
 * Google アカウントごとの同期状態を保持する Durable Object (account 単位。プロファイル単位
 * ではない — 1 プロファイルに複数アカウントがぶら下がっていても DO は分かれたまま)。
 * `env.USER_SYNC.getByName(accountId)` で常に同じインスタンスに到達する。
 *
 * 保持するもの:
 * - calendarId ごとの Google Calendar syncToken
 * - キャッシュした access_token とその有効期限 (D1 の refresh_token から都度取り直すのを避ける)
 */
export class UserSyncDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // token_cache.access_token は平文で保存する (accepted risk: 寿命が ~1h と短く、
      // D1 の refresh_token (無期限・暗号化対象) とはリスクの性質が違うため)。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS token_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_tokens (
          calendar_id TEXT PRIMARY KEY,
          sync_token TEXT
        )
      `)
      // ポーリングフォールバック (ProfileHubDO 経由で SSE 接続数が 0→1/1→0 になった時に
      // enablePolling/disablePolling される) の状態。1 DO = 1 account なので単一行。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS polling_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          account_id TEXT,
          profile_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 0
        )
      `)
      // calendar_id ごとの軽量チェック (hasUpdatesSince) の基準時刻。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS poll_watermarks (
          calendar_id TEXT PRIMARY KEY,
          since TEXT NOT NULL
        )
      `)
    })
  }

  async sync(accountId: string, calendarId: string): Promise<RpcResult<SyncResponse>> {
    return runRpc(() => syncCalendar(this.buildDeps(accountId), calendarId))
  }

  async listCalendars(accountId: string): Promise<RpcResult<CalendarListEntryDTO[]>> {
    return runRpc(async () => {
      const deps = this.buildDeps(accountId)
      const accessToken = await deps.getAccessToken()
      return fetchCalendarList(fetch, accessToken)
    })
  }

  /** POST /api/watch (watch 登録) と Cron 更新が、Google 呼び出し用に有効な access_token を取るための RPC。 */
  async getValidAccessToken(accountId: string): Promise<RpcResult<string>> {
    return runRpc(() => this.getOrRefreshAccessToken(accountId, false))
  }

  /**
   * POST /api/event/patch (フェーズ5): 予定の時刻変更を Google へ書き戻す。
   * 成功しても戻り値は無い (void) — 正本は次の同期 (webhook/ポーリング → SSE
   * 'changed' → クライアントの /api/sync) で還流する設計であり、ここで Google の
   * 応答をクライアントへそのまま返すことはしない (patch-event.ts のコメント参照)。
   * 404/403/412 等は runRpc が GoogleApiError として拾い、実 status のまま
   * RpcResult に載せる。route 側でこれを見て 409 等にマップする。
   */
  async patchEvent(
    accountId: string,
    calendarId: string,
    eventId: string,
    startMs: number,
    endMs: number,
    timeZone: string,
  ): Promise<RpcResult<void>> {
    return runRpc(() =>
      patchEventTimeWithRetry(this.buildPatchDeps(accountId), { calendarId, eventId, startMs, endMs, timeZone }),
    )
  }

  /** アカウント削除 (連携解除) 用: このユーザーの同期状態 (syncToken・access_token キャッシュ・ポーリング状態) を全消去する。 */
  async clearSyncState(): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec('DELETE FROM token_cache')
      this.ctx.storage.sql.exec('DELETE FROM sync_tokens')
      this.ctx.storage.sql.exec('DELETE FROM polling_state')
      this.ctx.storage.sql.exec('DELETE FROM poll_watermarks')
      await this.ctx.storage.deleteAlarm()
    })
  }

  /**
   * ProfileHubDO から呼ばれる RPC: この account を持つ profile の SSE 接続が 0→1 になった。
   * まだ alarm が無ければ設定する (既にポーリング中なら何もしない — 間隔がリセットされて
   * 通知が遅れるのを防ぐ)。
   */
  async enablePolling(accountId: string, profileId: string): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec(
        `INSERT INTO polling_state (id, account_id, profile_id, enabled) VALUES (1, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, profile_id = excluded.profile_id, enabled = 1`,
        accountId,
        profileId,
      )
      const existingAlarm = await this.ctx.storage.getAlarm()
      if (existingAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
      }
    })
  }

  /** ProfileHubDO から呼ばれる RPC: この account を持つ profile の SSE 接続が 1→0 になった。 */
  async disablePolling(): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec('UPDATE polling_state SET enabled = 0 WHERE id = 1')
      await this.ctx.storage.deleteAlarm()
    })
  }

  /**
   * ポーリングフォールバック本体。直近 sync 済み (= sync_tokens に行がある) カレンダー
   * ごとに軽量チェック (hasUpdatesSince, syncToken を消費しない) を行い、変化があれば
   * ProfileHubDO.notifyChanged を呼ぶ。disablePolling で無効化された後にたまたま発火した
   * 場合は何もせず再スケジュールもしない (deleteAlarm 済みのはずだが、実行と解除が
   * 競合した場合の保険)。
   */
  async alarm(): Promise<void> {
    const state = this.readPollingState()
    if (!state || state.enabled === 0 || !state.account_id || !state.profile_id) {
      return
    }
    const accountId = state.account_id
    const profileId = state.profile_id

    const calendarIds = this.ctx.storage.sql
      .exec<{ calendar_id: string }>('SELECT calendar_id FROM sync_tokens')
      .toArray()
      .map((row) => row.calendar_id)

    let accessToken: string
    try {
      accessToken = await this.getOrRefreshAccessToken(accountId, false)
    } catch (err) {
      console.error(`UserSyncDO alarm: failed to get access token for account ${accountId}`, err)
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
      return
    }

    for (const calendarId of calendarIds) {
      try {
        const changed = await this.checkCalendarForChanges(accessToken, calendarId)
        if (changed) {
          const hub = this.env.PROFILE_HUB.getByName(profileId)
          await hub.notifyChanged(accountId, calendarId)
        }
      } catch (err) {
        // 1つのカレンダーのチェックに失敗しても他のカレンダーは続行する。
        console.error(`UserSyncDO alarm: poll check failed for account=${accountId} calendar=${calendarId}`, err)
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS)
  }

  /**
   * 軽量チェック本体。watermark が無い (= このカレンダーを初めてチェックする) 場合は
   * 「今の時刻」を基準として記録するだけで、この回は変化ありと判定しない
   * (基準が無い状態で hasUpdatesSince を呼ぶと、過去のすべての更新を「変化」として
   * 誤検知してしまうため)。
   */
  private async checkCalendarForChanges(accessToken: string, calendarId: string): Promise<boolean> {
    const since = this.readPollWatermark(calendarId)
    const now = new Date().toISOString()
    if (since === null) {
      this.writePollWatermark(calendarId, now)
      return false
    }
    const changed = await hasUpdatesSince(fetch, accessToken, calendarId, since)
    this.writePollWatermark(calendarId, now)
    return changed
  }

  private readPollingState(): PollingStateRow | null {
    const rows = this.ctx.storage.sql
      .exec<PollingStateRow>('SELECT account_id, profile_id, enabled FROM polling_state WHERE id = 1')
      .toArray()
    return rows[0] ?? null
  }

  private readPollWatermark(calendarId: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<PollWatermarkRow>('SELECT since FROM poll_watermarks WHERE calendar_id = ?', calendarId)
      .toArray()
    return rows[0]?.since ?? null
  }

  private writePollWatermark(calendarId: string, since: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO poll_watermarks (calendar_id, since) VALUES (?, ?)
       ON CONFLICT(calendar_id) DO UPDATE SET since = excluded.since`,
      calendarId,
      since,
    )
  }

  private buildDeps(accountId: string): SyncCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(accountId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(accountId, true),
      getSyncToken: (calendarId) => Promise.resolve(this.readSyncToken(calendarId)),
      saveSyncToken: (calendarId, syncToken) => Promise.resolve(this.writeSyncToken(calendarId, syncToken)),
    }
  }

  private buildPatchDeps(accountId: string): PatchEventCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(accountId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(accountId, true),
    }
  }

  private async getOrRefreshAccessToken(accountId: string, forceRefresh: boolean): Promise<string> {
    if (!forceRefresh) {
      const cached = this.readCachedToken()
      if (cached && cached.expires_at > Date.now() + TOKEN_EXPIRY_SKEW_SECONDS * 1000) {
        return cached.access_token
      }
    }

    const row = await this.env.DB.prepare('SELECT refresh_token FROM accounts WHERE id = ?')
      .bind(accountId)
      .first<{ refresh_token: string }>()
    if (!row) {
      throw new NotConnectedError()
    }

    let refreshToken: string
    try {
      refreshToken = await decryptToken(this.env.TOKEN_ENC_KEY, row.refresh_token)
    } catch (err) {
      if (err instanceof InvalidCiphertextError) {
        // v1: プレフィックスの無い行 (暗号化導入前の平文データ) や、改ざん/鍵不一致による
        // 復号失敗。既存データは dev 用のダミーしか無いため移行コードは書かず、単純に
        // 「未連携」として扱い再連携 (再ログイン) に誘導する。
        throw new NotConnectedError()
      }
      throw err
    }

    const refreshed = await refreshAccessToken(
      fetch,
      { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET },
      refreshToken,
    )

    // 先に永続化してからメモリ上の呼び出し元へ返す (persist first, cache second)
    this.writeCachedToken(refreshed.accessToken, Date.now() + refreshed.expiresIn * 1000)
    return refreshed.accessToken
  }

  private readCachedToken(): TokenCacheRow | null {
    const rows = this.ctx.storage.sql
      .exec<TokenCacheRow>('SELECT access_token, expires_at FROM token_cache WHERE id = 1')
      .toArray()
    return rows[0] ?? null
  }

  private writeCachedToken(accessToken: string, expiresAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO token_cache (id, access_token, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`,
      accessToken,
      expiresAt,
    )
  }

  private readSyncToken(calendarId: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<SyncTokenRow>('SELECT sync_token FROM sync_tokens WHERE calendar_id = ?', calendarId)
      .toArray()
    return rows[0]?.sync_token ?? null
  }

  private writeSyncToken(calendarId: string, syncToken: string | null): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO sync_tokens (calendar_id, sync_token) VALUES (?, ?)
       ON CONFLICT(calendar_id) DO UPDATE SET sync_token = excluded.sync_token`,
      calendarId,
      syncToken,
    )
  }
}
