import { DurableObject } from "cloudflare:workers";
import type {
  CalendarListEntryDTO,
  GoogleEventDTO,
  GoogleTaskDTO,
  SyncResponse,
  TaskListDTO,
} from "@kichijitsu/shared";
import { fetchCalendarList } from "../google/calendar-list";
import { refreshAccessToken } from "../google/oauth";
import { hasUpdatesSince } from "../google/poll-check";
import { syncCalendar, type SyncCoreDeps } from "../core/sync";
import {
  resolveSyncTokenRead,
  V2_TOKEN_MAX_AGE_MS,
  wrapGetSyncTokenForForceFull,
} from "../core/sync-token-store";
import { patchEventTimeWithRetry, type PatchEventCoreDeps } from "../core/patch-event";
import { createEventWithRetry, type CreateEventCoreDeps } from "../core/create-event";
import { deleteEventWithRetry, type DeleteEventCoreDeps } from "../core/delete-event";
import {
  listEventsInWindowWithRetry,
  type ListEventsInWindowCoreDeps,
  type ReconcileWindow,
} from "../core/list-events";
import { insertEventWithRetry, type InsertEventCoreDeps } from "../core/insert-event";
import { patchEventRawWithRetry, type PatchEventRawCoreDeps } from "../core/patch-event-raw";
import type { MirrorEventBody } from "../core/block-reconcile";
import type { RawEventTimeField } from "../google/patch-event-raw";
import {
  listTaskLists as listTaskListsCore,
  patchTaskStatusWithRetry,
  syncTasks as syncTasksCore,
  type TasksCoreDeps,
} from "../core/tasks";
import { NotConnectedError } from "../core/errors";
import { runRpc, type RpcResult } from "../rpc-result";
import { decryptToken, InvalidCiphertextError } from "../crypto";

// アクセストークンをこの秒数前倒しで期限切れ扱いにし、ギリギリで失効したリクエストを防ぐ。
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

// ポーリングフォールバックの間隔 (design: 10分)。SSE 接続が1つでもある profile の
// アカウントに対してのみ動く (ProfileHubDO.enablePolling/disablePolling で開閉する)。
const POLL_INTERVAL_MS = 10 * 60 * 1000;

interface TokenCacheRow extends Record<string, SqlStorageValue> {
  access_token: string;
  expires_at: number;
}

interface SyncTokenRow extends Record<string, SqlStorageValue> {
  sync_token: string | null;
}

interface PollingStateRow extends Record<string, SqlStorageValue> {
  account_id: string | null;
  profile_id: string | null;
  enabled: number;
}

interface PollWatermarkRow extends Record<string, SqlStorageValue> {
  since: string;
}

/**
 * Google アカウントごとの同期状態を保持する Durable Object (account 単位。プロファイル単位
 * ではない — 1 プロファイルに複数アカウントがぶら下がっていても DO は分かれたまま)。
 * `env.USER_SYNC.getByName(accountId)` で常に同じインスタンスに到達する。
 *
 * 保持するもの:
 * - (calendarId, deviceId) ごとの Google Calendar syncToken (sync_tokens_v2、2026-07-21
 *   端末ごと syncToken)。各端末がローカルレプリカ (IndexedDB) を持つ設計のため、
 *   差分は端末ごとに独立して配られなければならない — calendarId だけをキーにした旧
 *   sync_tokens (全端末共有) は、新規端末の初回同期を全同期にしないための seed 専用
 *   として読み取り専用で残す (readSyncToken/writeSyncToken 参照)
 * - キャッシュした access_token とその有効期限 (D1 の refresh_token から都度取り直すのを避ける)
 */
export class UserSyncDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // token_cache.access_token は平文で保存する (accepted risk: 寿命が ~1h と短く、
      // D1 の refresh_token (無期限・暗号化対象) とはリスクの性質が違うため)。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS token_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_tokens (
          calendar_id TEXT PRIMARY KEY,
          sync_token TEXT
        )
      `);
      // 端末ごと syncToken (2026-07-21、design flaw 修正): 上の sync_tokens は
      // calendar_id だけをキーにしており全端末で共有されていた — 端末Aが同期すると
      // トークンが進み、その差分は A の IndexedDB にしか適用されないため、端末Bは
      // その差分を永久に取りこぼす欠陥があった。以後の書き込みは device_id ごとに
      // 分離したこちらのテーブルへ行う (readSyncToken/writeSyncToken 参照)。旧テーブルは
      // 「新規端末の初回同期を全同期にしない」ための seed 専用として読み取り専用で残す
      // (以後は書き込まない)。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_tokens_v2 (
          calendar_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          sync_token TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (calendar_id, device_id)
        )
      `);
      // ポーリングフォールバック (ProfileHubDO 経由で SSE 接続数が 0→1/1→0 になった時に
      // enablePolling/disablePolling される) の状態。1 DO = 1 account なので単一行。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS polling_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          account_id TEXT,
          profile_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 0
        )
      `);
      // calendar_id ごとの軽量チェック (hasUpdatesSince) の基準時刻。
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS poll_watermarks (
          calendar_id TEXT PRIMARY KEY,
          since TEXT NOT NULL
        )
      `);
    });
  }

  /**
   * deviceId 省略 (旧クライアントの in-flight リクエスト、または未対応呼び出し元) は
   * レガシー共有トークン (sync_tokens) を従来どおり読み書きする後方互換パス。
   * deviceId 指定時は端末ごとの sync_tokens_v2 を使う (readSyncToken/writeSyncToken 参照)。
   *
   * forceFull (2026-07-22、SyncRequest.forceFull): true なら保存済み syncToken を無視して
   * 全同期を強制する (eventType バックフィル用、buildDeps のラップ参照)。
   */
  async sync(
    accountId: string,
    calendarId: string,
    deviceId?: string,
    forceFull?: boolean,
  ): Promise<RpcResult<SyncResponse>> {
    return runRpc(() => syncCalendar(this.buildDeps(accountId, deviceId, forceFull), calendarId));
  }

  async listCalendars(accountId: string): Promise<RpcResult<CalendarListEntryDTO[]>> {
    return runRpc(async () => {
      const deps = this.buildDeps(accountId);
      const accessToken = await deps.getAccessToken();
      return fetchCalendarList(fetch, accessToken);
    });
  }

  /** POST /api/watch (watch 登録) と Cron 更新が、Google 呼び出し用に有効な access_token を取るための RPC。 */
  async getValidAccessToken(accountId: string): Promise<RpcResult<string>> {
    return runRpc(() => this.getOrRefreshAccessToken(accountId, false));
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
      patchEventTimeWithRetry(this.buildEventWriteDeps(accountId), {
        calendarId,
        eventId,
        startMs,
        endMs,
        timeZone,
      }),
    );
  }

  /**
   * POST /api/event/create (フェーズ5): 新規予定を Google に作成する。
   * 成功時は作成された event の id を返す (UI が楽観的 occurrence の id を確定 id に
   * 差し替えるため) — それ以外の作成結果を正本として扱うことはしない。正本は次の同期
   * (webhook/ポーリング → SSE 'changed' → クライアントの /api/sync) で還流する設計
   * (create-event.ts のコメント参照)。403/412/5xx 等は runRpc が GoogleApiError として
   * 拾い、実 status のまま RpcResult に載せる。route 側でこれを見て 409 等にマップする。
   */
  async createEvent(
    accountId: string,
    calendarId: string,
    title: string,
    startMs: number,
    endMs: number,
    timeZone: string,
  ): Promise<RpcResult<string>> {
    return runRpc(() =>
      createEventWithRetry(this.buildEventWriteDeps(accountId), {
        calendarId,
        title,
        startMs,
        endMs,
        timeZone,
      }),
    );
  }

  /**
   * POST /api/event/delete (フェーズ5): 予定を Google から削除する。
   * 404 (既に削除済み) は deleteEventWithRetry 内で成功扱いにする (冪等)。成功しても
   * 戻り値は無い (void) — 正本は次の同期 (webhook/ポーリング → SSE 'changed' →
   * クライアントの /api/sync) で還流する設計であり、ここで Google の応答をクライアントへ
   * そのまま返すことはしない (delete-event.ts のコメント参照)。403/412/5xx 等は runRpc が
   * GoogleApiError として拾い、実 status のまま RpcResult に載せる。route 側でこれを見て
   * 409 等にマップする。
   */
  async deleteEvent(
    accountId: string,
    calendarId: string,
    eventId: string,
  ): Promise<RpcResult<void>> {
    return runRpc(() =>
      deleteEventWithRetry(this.buildEventWriteDeps(accountId), { calendarId, eventId }),
    );
  }

  /**
   * カレンダーブロック機能 (docs/blocking.md 第3段階): ProfileHubDO のリコンサイルが
   * source カレンダーの現予定集合を取得するための RPC。指定した期間ウィンドウ内の
   * イベントを (ページングを内部で吸収して) 全件返す。
   */
  async listEventsInWindow(
    accountId: string,
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<RpcResult<GoogleEventDTO[]>> {
    return runRpc(() =>
      listEventsInWindowWithRetry(this.buildEventWriteDeps(accountId), calendarId, {
        timeMin,
        timeMax,
      } satisfies ReconcileWindow),
    );
  }

  /**
   * カレンダーブロック機能 (docs/blocking.md 第3段階): ProfileHubDO のリコンサイルが
   * target カレンダーに mirror (Busy/不在ブロック) を作成するための RPC。createEvent
   * (title/startMs/endMs 限定) とは別に、extendedProperties/transparency/visibility/
   * eventType を含む body をそのまま送れる汎用版が必要なため用意した。
   * 作成された mirror event の id を返す (block_mirrors への保存に使う)。
   */
  async createMirrorEvent(
    accountId: string,
    calendarId: string,
    body: MirrorEventBody,
  ): Promise<RpcResult<{ id: string; oooFallback: boolean }>> {
    return runRpc(() =>
      insertEventWithRetry(this.buildEventWriteDeps(accountId), calendarId, body),
    );
  }

  /**
   * カレンダーブロック機能 (docs/blocking.md 第3段階): ProfileHubDO のリコンサイルが
   * mirror の時刻を source の変更に追従させるための RPC。patchEvent (epoch ms + timeZone、
   * 時刻予定限定) とは別に、source の start/end (終日予定の date を含む) をそのまま
   * 写せる raw 版が必要なため用意した。
   */
  async patchEventRaw(
    accountId: string,
    calendarId: string,
    eventId: string,
    start: RawEventTimeField,
    end: RawEventTimeField,
  ): Promise<RpcResult<void>> {
    return runRpc(() =>
      patchEventRawWithRetry(this.buildEventWriteDeps(accountId), {
        calendarId,
        eventId,
        start,
        end,
      }),
    );
  }

  /**
   * GET /api/tasklists (Google タスク連携、docs/google-tasks.md): アカウントのタスク
   * リスト一覧を取得する。tasks スコープ未付与は Google が 403 を返し、runRpc が
   * GoogleApiError としてそのまま status=403 で RpcResult に載せる — route 側でこれを
   * tasks_scope_missing に変換する。
   */
  async listTaskLists(accountId: string): Promise<RpcResult<TaskListDTO[]>> {
    return runRpc(() => listTaskListsCore(this.buildTasksDeps(accountId)));
  }

  /**
   * POST /api/tasks/sync (Google タスク連携): 指定タスクリストの全タスクを取得する
   * (ページング込み)。Tasks API に syncToken は無いため常に全件取得。
   */
  async syncTasks(accountId: string, taskListId: string): Promise<RpcResult<GoogleTaskDTO[]>> {
    return runRpc(() => syncTasksCore(this.buildTasksDeps(accountId), taskListId));
  }

  /**
   * POST /api/task/patch (Google タスク連携): タスクの完了状態を Google へ書き戻す。
   * 戻り値は無い (void) — 正本は次の /api/tasks/sync 再取得で還流する設計 (core/tasks.ts
   * のコメント参照)。403/404 等や 401 リトライ後もなお失敗する場合は GoogleApiError の
   * まま RpcResult に載る — route 側でこれを 409 patch_failed 等にマップする。
   */
  async patchTask(
    accountId: string,
    taskListId: string,
    taskId: string,
    status: "needsAction" | "completed",
  ): Promise<RpcResult<void>> {
    return runRpc(() =>
      patchTaskStatusWithRetry(this.buildTasksDeps(accountId), { taskListId, taskId, status }),
    );
  }

  /** アカウント削除 (連携解除) 用: このユーザーの同期状態 (syncToken・access_token キャッシュ・ポーリング状態) を全消去する。 */
  async clearSyncState(): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec("DELETE FROM token_cache");
      this.ctx.storage.sql.exec("DELETE FROM sync_tokens");
      this.ctx.storage.sql.exec("DELETE FROM sync_tokens_v2");
      this.ctx.storage.sql.exec("DELETE FROM polling_state");
      this.ctx.storage.sql.exec("DELETE FROM poll_watermarks");
      await this.ctx.storage.deleteAlarm();
    });
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
      );
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      }
    });
  }

  /** ProfileHubDO から呼ばれる RPC: この account を持つ profile の SSE 接続が 1→0 になった。 */
  async disablePolling(): Promise<RpcResult<void>> {
    return runRpc(async () => {
      this.ctx.storage.sql.exec("UPDATE polling_state SET enabled = 0 WHERE id = 1");
      await this.ctx.storage.deleteAlarm();
    });
  }

  /**
   * ポーリングフォールバック本体。直近 sync 済み (= sync_tokens または sync_tokens_v2 に
   * 行がある、2026-07-21 端末ごと syncToken 以降は後者が主) カレンダーごとに軽量チェック
   * (hasUpdatesSince, syncToken を消費しない) を行い、変化があれば
   * ProfileHubDO.notifyChanged を呼ぶ。disablePolling で無効化された後にたまたま発火した
   * 場合は何もせず再スケジュールもしない (deleteAlarm 済みのはずだが、実行と解除が
   * 競合した場合の保険)。
   */
  async alarm(): Promise<void> {
    const state = this.readPollingState();
    if (!state || state.enabled === 0 || !state.account_id || !state.profile_id) {
      return;
    }
    const accountId = state.account_id;
    const profileId = state.profile_id;

    // 端末ごと syncToken (2026-07-21) 以降、レガシー sync_tokens には新規カレンダーの行が
    // 増えなくなった (writeSyncToken が凍結、seed 専用) ので、sync_tokens_v2 側の
    // calendar_id も合わせて見ないと、v2 のみで同期されているカレンダーがポーリング
    // フォールバック対象から漏れてしまう。
    const calendarIds = this.ctx.storage.sql
      .exec<{ calendar_id: string }>(
        "SELECT calendar_id FROM sync_tokens UNION SELECT calendar_id FROM sync_tokens_v2",
      )
      .toArray()
      .map((row) => row.calendar_id);

    let accessToken: string;
    try {
      accessToken = await this.getOrRefreshAccessToken(accountId, false);
    } catch (err) {
      console.error(`UserSyncDO alarm: failed to get access token for account ${accountId}`, err);
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return;
    }

    for (const calendarId of calendarIds) {
      try {
        const changed = await this.checkCalendarForChanges(accessToken, calendarId);
        if (changed) {
          const hub = this.env.PROFILE_HUB.getByName(profileId);
          await hub.notifyChanged(accountId, calendarId, profileId);
        }
      } catch (err) {
        // 1つのカレンダーのチェックに失敗しても他のカレンダーは続行する。
        console.error(
          `UserSyncDO alarm: poll check failed for account=${accountId} calendar=${calendarId}`,
          err,
        );
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }

  /**
   * 軽量チェック本体。watermark が無い (= このカレンダーを初めてチェックする) 場合は
   * 「今の時刻」を基準として記録するだけで、この回は変化ありと判定しない
   * (基準が無い状態で hasUpdatesSince を呼ぶと、過去のすべての更新を「変化」として
   * 誤検知してしまうため)。
   */
  private async checkCalendarForChanges(accessToken: string, calendarId: string): Promise<boolean> {
    const since = this.readPollWatermark(calendarId);
    const now = new Date().toISOString();
    if (since === null) {
      this.writePollWatermark(calendarId, now);
      return false;
    }
    const changed = await hasUpdatesSince(fetch, accessToken, calendarId, since);
    this.writePollWatermark(calendarId, now);
    return changed;
  }

  private readPollingState(): PollingStateRow | null {
    const rows = this.ctx.storage.sql
      .exec<PollingStateRow>(
        "SELECT account_id, profile_id, enabled FROM polling_state WHERE id = 1",
      )
      .toArray();
    return rows[0] ?? null;
  }

  private readPollWatermark(calendarId: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<PollWatermarkRow>("SELECT since FROM poll_watermarks WHERE calendar_id = ?", calendarId)
      .toArray();
    return rows[0]?.since ?? null;
  }

  private writePollWatermark(calendarId: string, since: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO poll_watermarks (calendar_id, since) VALUES (?, ?)
       ON CONFLICT(calendar_id) DO UPDATE SET since = excluded.since`,
      calendarId,
      since,
    );
  }

  /**
   * deviceId を read/write クロージャに束ねる (core/sync.ts の SyncCoreDeps 形状自体は
   * 変えない — calendarId だけを引数に取る getSyncToken/saveSyncToken のシグネチャは
   * そのまま、この DO 側で deviceId を閉じ込める)。
   *
   * forceFull (2026-07-22): wrapGetSyncTokenForForceFull で getSyncToken だけを差し替える。
   * saveSyncToken は素通しのまま渡す — 全同期完了後は core/sync.ts が新トークンを通常どおり
   * 保存するので、以後は自動的に増分同期に戻る。
   */
  private buildDeps(accountId: string, deviceId?: string, forceFull?: boolean): SyncCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(accountId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(accountId, true),
      getSyncToken: wrapGetSyncTokenForForceFull(
        (calendarId) => Promise.resolve(this.readSyncToken(calendarId, deviceId)),
        forceFull ?? false,
      ),
      saveSyncToken: (calendarId, syncToken) =>
        Promise.resolve(this.writeSyncToken(calendarId, deviceId, syncToken)),
    };
  }

  /**
   * patch/create/delete (+ カレンダーブロック機能の listEventsInWindow/createMirrorEvent/
   * patchEventRaw) の書き戻し RPC 共通の依存先。いずれも
   * { fetch, getAccessToken, forceRefreshAccessToken } と構造的に同一なので、1つの実装を
   * 全員に渡す。
   */
  private buildEventWriteDeps(
    accountId: string,
  ): PatchEventCoreDeps &
    CreateEventCoreDeps &
    DeleteEventCoreDeps &
    ListEventsInWindowCoreDeps &
    InsertEventCoreDeps &
    PatchEventRawCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(accountId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(accountId, true),
    };
  }

  /** listTaskLists/syncTasks/patchTask 共通の依存先。buildEventWriteDeps と同じ考え方。 */
  private buildTasksDeps(accountId: string): TasksCoreDeps {
    return {
      fetch,
      getAccessToken: () => this.getOrRefreshAccessToken(accountId, false),
      forceRefreshAccessToken: () => this.getOrRefreshAccessToken(accountId, true),
    };
  }

  private async getOrRefreshAccessToken(accountId: string, forceRefresh: boolean): Promise<string> {
    if (!forceRefresh) {
      const cached = this.readCachedToken();
      if (cached && cached.expires_at > Date.now() + TOKEN_EXPIRY_SKEW_SECONDS * 1000) {
        return cached.access_token;
      }
    }

    const row = await this.env.DB.prepare("SELECT refresh_token FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ refresh_token: string }>();
    if (!row) {
      throw new NotConnectedError();
    }

    let refreshToken: string;
    try {
      refreshToken = await decryptToken(this.env.TOKEN_ENC_KEY, row.refresh_token);
    } catch (err) {
      if (err instanceof InvalidCiphertextError) {
        // v1: プレフィックスの無い行 (暗号化導入前の平文データ) や、改ざん/鍵不一致による
        // 復号失敗。既存データは dev 用のダミーしか無いため移行コードは書かず、単純に
        // 「未連携」として扱い再連携 (再ログイン) に誘導する。
        throw new NotConnectedError();
      }
      throw err;
    }

    const refreshed = await refreshAccessToken(
      fetch,
      { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET },
      refreshToken,
    );

    // 先に永続化してからメモリ上の呼び出し元へ返す (persist first, cache second)
    this.writeCachedToken(refreshed.accessToken, Date.now() + refreshed.expiresIn * 1000);
    return refreshed.accessToken;
  }

  private readCachedToken(): TokenCacheRow | null {
    const rows = this.ctx.storage.sql
      .exec<TokenCacheRow>("SELECT access_token, expires_at FROM token_cache WHERE id = 1")
      .toArray();
    return rows[0] ?? null;
  }

  private writeCachedToken(accessToken: string, expiresAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO token_cache (id, access_token, expires_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at`,
      accessToken,
      expiresAt,
    );
  }

  /**
   * 端末ごと syncToken (2026-07-21)。分岐の判定ロジック自体は sync-token-store.ts の
   * resolveSyncTokenRead (純関数・テスト済み) に切り出してある — ここでは行取得のみ行う。
   * deviceId 無し (旧クライアント) はレガシー共有テーブルのみを見る。deviceId 有りは
   * sync_tokens_v2 を優先し、無ければレガシー行を「この端末の初回同期用の seed」として使う
   * (Google の syncToken は複数クライアントで fork でき、以後は端末ごとに独立して進む)。
   */
  private readSyncToken(calendarId: string, deviceId?: string): string | null {
    const legacyRow = this.readLegacySyncTokenRow(calendarId);
    const v2Row = deviceId === undefined ? null : this.readV2SyncTokenRow(calendarId, deviceId);
    return resolveSyncTokenRead(deviceId !== undefined, v2Row, legacyRow);
  }

  private readLegacySyncTokenRow(calendarId: string): SyncTokenRow | null {
    const rows = this.ctx.storage.sql
      .exec<SyncTokenRow>("SELECT sync_token FROM sync_tokens WHERE calendar_id = ?", calendarId)
      .toArray();
    return rows[0] ?? null;
  }

  private readV2SyncTokenRow(calendarId: string, deviceId: string): SyncTokenRow | null {
    const rows = this.ctx.storage.sql
      .exec<SyncTokenRow>(
        "SELECT sync_token FROM sync_tokens_v2 WHERE calendar_id = ? AND device_id = ?",
        calendarId,
        deviceId,
      )
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * deviceId 無し (旧クライアント) はレガシー共有テーブルへ従来どおり書く。deviceId 有りは
   * sync_tokens_v2 へ upsert し、レガシー表へは二度と書かない (seed 専用として凍結する —
   * 他端末が読む「初回 seed」の値を勝手に進めてしまわないため)。書き込みのたびに、この
   * calendar の古い (60日超更新無し) v2 行を軽く掃除する (消えた端末のトークンを溜めない)。
   */
  private writeSyncToken(
    calendarId: string,
    deviceId: string | undefined,
    syncToken: string | null,
  ): void {
    if (deviceId === undefined) {
      this.ctx.storage.sql.exec(
        `INSERT INTO sync_tokens (calendar_id, sync_token) VALUES (?, ?)
         ON CONFLICT(calendar_id) DO UPDATE SET sync_token = excluded.sync_token`,
        calendarId,
        syncToken,
      );
      return;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO sync_tokens_v2 (calendar_id, device_id, sync_token, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(calendar_id, device_id) DO UPDATE SET
         sync_token = excluded.sync_token,
         updated_at = excluded.updated_at`,
      calendarId,
      deviceId,
      syncToken,
      Date.now(),
    );
    this.pruneStaleV2SyncTokens(calendarId);
  }

  /** この calendar の sync_tokens_v2 のうち、V2_TOKEN_MAX_AGE_MS (60日) 超更新の無い行を削除する。 */
  private pruneStaleV2SyncTokens(calendarId: string): void {
    const cutoff = Date.now() - V2_TOKEN_MAX_AGE_MS;
    this.ctx.storage.sql.exec(
      "DELETE FROM sync_tokens_v2 WHERE calendar_id = ? AND updated_at < ?",
      calendarId,
      cutoff,
    );
  }
}
