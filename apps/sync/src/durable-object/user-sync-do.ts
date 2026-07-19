import { DurableObject } from 'cloudflare:workers'
import type { CalendarListEntryDTO, SyncResponse } from '@kichijitsu/shared'
import { fetchCalendarList } from '../google/calendar-list'
import { refreshAccessToken } from '../google/oauth'
import { syncCalendar, type SyncCoreDeps } from '../core/sync'
import { NotConnectedError } from '../core/errors'
import { runRpc, type RpcResult } from '../rpc-result'
import { decryptToken, InvalidCiphertextError } from '../crypto'

// アクセストークンをこの秒数前倒しで期限切れ扱いにし、ギリギリで失効したリクエストを防ぐ。
const TOKEN_EXPIRY_SKEW_SECONDS = 60

interface TokenCacheRow extends Record<string, SqlStorageValue> {
  access_token: string
  expires_at: number
}

interface SyncTokenRow extends Record<string, SqlStorageValue> {
  sync_token: string | null
}

/**
 * ユーザーごとの同期状態を保持する Durable Object。
 * `env.USER_SYNC.getByName(userId)` で常に同じインスタンスに到達する。
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
    })
  }

  async sync(userId: string, calendarId: string): Promise<RpcResult<SyncResponse>> {
    return runRpc(() => syncCalendar(this.buildDeps(userId), calendarId))
  }

  async listCalendars(userId: string): Promise<RpcResult<CalendarListEntryDTO[]>> {
    return runRpc(async () => {
      const deps = this.buildDeps(userId)
      const accessToken = await deps.getAccessToken()
      return fetchCalendarList(fetch, accessToken)
    })
  }

  /** アカウント削除 (連携解除) 用: このユーザーの同期状態 (syncToken・access_token キャッシュ) を全消去する。 */
  async clearSyncState(): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec('DELETE FROM token_cache')
      this.ctx.storage.sql.exec('DELETE FROM sync_tokens')
    })
  }

  private buildDeps(userId: string): SyncCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(userId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(userId, true),
      getSyncToken: (calendarId) => Promise.resolve(this.readSyncToken(calendarId)),
      saveSyncToken: (calendarId, syncToken) => Promise.resolve(this.writeSyncToken(calendarId, syncToken)),
    }
  }

  private async getOrRefreshAccessToken(userId: string, forceRefresh: boolean): Promise<string> {
    if (!forceRefresh) {
      const cached = this.readCachedToken()
      if (cached && cached.expires_at > Date.now() + TOKEN_EXPIRY_SKEW_SECONDS * 1000) {
        return cached.access_token
      }
    }

    const row = await this.env.DB.prepare('SELECT refresh_token FROM users WHERE id = ?')
      .bind(userId)
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
