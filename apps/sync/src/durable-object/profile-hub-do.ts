import { DurableObject } from "cloudflare:workers";
import type { GoogleEventDTO, ServerEvent } from "@kichijitsu/shared";
import { SseRingBuffer } from "../core/sse-ring-buffer";
import {
  reconcileSourceChange,
  type ReconcileDeps,
  type ReconcileRule,
  type ReconcileWindow,
} from "../core/block-orchestrate";
import type { BlockMirrorRow, MirrorEventBody } from "../core/block-reconcile";
import {
  aggregateBlockRules,
  type BlockRuleRow,
  type BlockRuleSourceRow,
} from "../core/block-rules";
import { PROFILE_ID_HEADER } from "./profile-hub-protocol";

/**
 * Worker ルートとのワイヤ契約 (ヘッダ名) は profile-hub-protocol.ts に置いてある — この
 * ファイルは `cloudflare:workers` を import するため workerd の外では読み込めず、ルート側の
 * 単体テストから参照できなくなるため (2026-07-25)。ここからの再エクスポートは、DO 実装と
 * 同じ場所から読みたい呼び出し側のために残す。
 */
export { PROFILE_ID_HEADER } from "./profile-hub-protocol";

const KEEP_ALIVE_INTERVAL_MS = 20_000;

interface Session {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  closed: boolean;
}

function sseEvent(data: string, id?: number): Uint8Array {
  const idLine = id !== undefined ? `id: ${id}\n` : "";
  return new TextEncoder().encode(`${idLine}data: ${data}\n\n`);
}

function sseComment(text: string): Uint8Array {
  return new TextEncoder().encode(`: ${text}\n\n`);
}

function parseLastEventId(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  return Number.isInteger(n) ? n : null;
}

/**
 * プロファイル (= セッション) 単位の SSE ハブ。`env.PROFILE_HUB.getByName(profileId)` で
 * 常に同じインスタンスに到達する。
 *
 * 責務:
 * - GET /api/events からの SSE 接続を保持し、`notifyChanged` で受けた通知を配信する
 * - SSE 接続数が 0→1 / 1→0 になるタイミングで、このプロファイルに属する全アカウントの
 *   UserSyncDO へポーリングフォールバックの有効/無効を伝える
 *
 * **課金注意**: SSE 接続が張られている間、この DO は「active」としてウォールクロック
 * 時間分課金される (Durable Objects は「レスポンスストリームを保持している間は active」
 * という課金ルールのため)。個人〜招待制程度の同時接続数であれば許容できる前提で、
 * 接続時間に応じたコストの最適化 (例: 長時間アイドルなら能動的に切る等) はしていない。
 */
export class ProfileHubDO extends DurableObject<Env> {
  private readonly sessions = new Map<string, Session>();
  private readonly ringBuffer = new SseRingBuffer();
  private profileId: string | undefined;
  // カレンダーブロック機能 (docs/blocking.md 第3段階) のリコンサイル直列化用チェーン。
  // (accountId, calendarId) ごとに Promise を連結することで、同一 DO インスタンス内では
  // 同じ対象への reconcile が並行実行されない (簡易ロック)。**既知の限界**: これは
  // in-memory な状態であり、DO の再起動・退避 (eviction) を跨いでは保持されない。
  // また ProfileHubDO は原則同じ profile に対して単一インスタンスだが、理論上の競合
  // (例: 同時に複数リクエストが異なる DO 呼び出し経路で来た場合) までは完全には防げない
  // — 完全な冪等性は今回のスコープ外 (docs/blocking.md に既知の限界として記載)。
  private readonly reconcileChains = new Map<string, Promise<void>>();

  async fetch(request: Request): Promise<Response> {
    const profileId = request.headers.get(PROFILE_ID_HEADER);
    if (!profileId) {
      return new Response("missing profile id", { status: 400 });
    }
    this.profileId = profileId;

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const sessionId = crypto.randomUUID();
    const session: Session = { writer, closed: false };

    const wasEmpty = this.sessions.size === 0;
    this.sessions.set(sessionId, session);
    if (wasEmpty) {
      // 接続確立を遅らせないよう、ポーリング配線はバックグラウンドで行う。
      this.ctx.waitUntil(
        this.setPollingForProfile(profileId, true).catch((err) =>
          console.error(
            `ProfileHubDO: failed to start polling fallback for profile ${profileId}`,
            err,
          ),
        ),
      );
    }

    request.signal.addEventListener("abort", () => this.closeSession(sessionId));

    const lastEventId = parseLastEventId(request.headers.get("Last-Event-ID"));
    this.runSession(session, lastEventId).catch((err) => {
      console.error("ProfileHubDO: SSE session loop failed", err);
      this.closeSession(sessionId);
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // nginx 等のプロキシがバッファリングで詰まらせないように
      },
    });
  }

  /**
   * webhook / ポーリングフォールバックから呼ばれる RPC。接続中の全 SSE へ配信する。
   * `notifyChanged` はトリガーに過ぎない — ペイロードにイベント本体は含めない。
   *
   * `profileId` は呼び出し元 (webhook route / UserSyncDO.alarm) が既に知っている値を
   * 明示的に渡してもらう。`this.profileId` は SSE 接続 (fetch()) 時にしか設定されないため
   * (このファイル冒頭のコメント「DOs don't know their own ID」参照)、SSE 未接続のまま
   * webhook が先に届くケースでもカレンダーブロックのリコンサイル (profile 越境防止に
   * profileId が必須) が動くよう、ここで明示的に補っておく。
   */
  async notifyChanged(accountId: string, calendarId: string, profileId: string): Promise<void> {
    this.profileId = profileId;

    const event: ServerEvent = { type: "changed", accountId, calendarId };
    const buffered = this.ringBuffer.push(event);
    const payload = sseEvent(JSON.stringify(event), buffered.id);

    for (const [sessionId, session] of this.sessions) {
      try {
        await session.writer.write(payload);
      } catch {
        this.closeSession(sessionId);
      }
    }

    // カレンダーブロック機能 (docs/blocking.md 第3段階): SSE 配信を遅らせないよう
    // waitUntil でバックグラウンド実行する。ループ防止の不変条件: mirror は target
    // カレンダーに kichijitsuMirror=1 付きで作られ、reconcileBlockRule (block-reconcile.ts)
    // が isMirrorEvent で mirror 自身を source 集合から除外するため、target が別ルールの
    // source であっても mirror が新たな source として拾われて無限に増殖することはない。
    this.ctx.waitUntil(
      this.reconcileForSourceChange(accountId, calendarId).catch((err) =>
        console.error(
          `ProfileHubDO: reconcile failed for account=${accountId} calendar=${calendarId}`,
          err,
        ),
      ),
    );
  }

  /**
   * (accountId, calendarId) ごとに reconcile を直列化しつつ実行する。同時に複数の変更
   * 通知が来ても、同一対象への reconcile が並行に走って mirror を二重作成する事故を防ぐ
   * (完全な冪等性ではなく簡易ロック — クラス冒頭の reconcileChains のコメント参照)。
   */
  private async reconcileForSourceChange(accountId: string, calendarId: string): Promise<void> {
    // 直列化キーの区切りは U+0000 (NUL) — id に現れない文字なのでキー衝突が起きない。ソース上は
    // 生の 0x00 バイトではなくエスケープ表記で書く (生バイトを含むと git がファイルをバイナリ扱いして
    // diff が読めなくなる。文字コードは同じなので振る舞いは不変、2026-07-25)。
    const key = `${accountId}\u0000${calendarId}`;
    const previous = this.reconcileChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.runReconcile(accountId, calendarId));
    this.reconcileChains.set(key, next);
    try {
      await next;
    } finally {
      if (this.reconcileChains.get(key) === next) {
        this.reconcileChains.delete(key);
      }
    }
  }

  private async runReconcile(accountId: string, calendarId: string): Promise<void> {
    const nowMs = Date.now();
    const window: ReconcileWindow = {
      timeMin: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
      timeMax: new Date(nowMs + 60 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const deps: ReconcileDeps = {
      loadRulesForSource: (a, c) => this.loadRulesForSource(a, c),
      listSourceEvents: (a, c, w) => this.listSourceEvents(a, c, w),
      loadMirrors: (ruleId) => this.loadMirrors(ruleId),
      createMirror: (ta, tc, body) => this.createMirror(ta, tc, body),
      patchMirrorTime: (ta, tc, mirrorEventId, start, end) =>
        this.patchMirrorTime(ta, tc, mirrorEventId, start, end),
      deleteMirror: (ta, tc, mirrorEventId) => this.deleteMirror(ta, tc, mirrorEventId),
      saveMirrorRow: (row) => this.saveMirrorRow(row),
      updateMirrorRow: (ruleId, sourceEventId, sourceUpdated) =>
        this.updateMirrorRow(ruleId, sourceEventId, sourceUpdated),
      deleteMirrorRow: (ruleId, sourceEventId) => this.deleteMirrorRow(ruleId, sourceEventId),
      setRuleOooFallback: (ruleId, value) => this.setRuleOooFallback(ruleId, value),
      now: () => Date.now(),
    };
    await reconcileSourceChange(accountId, calendarId, window, deps);
  }

  /**
   * (accountId, calendarId) を source に持つ、**このプロファイルに属する** ルールのみを
   * 返す (profile 越境防止)。block_rule_sources で該当ルール ID を引き、そのルール本体と
   * 全 source (この1件だけでなく複数 source 全部) を集約する — routes/api.ts の
   * loadBlockRules と同じ集約ロジック (aggregateBlockRules) を再利用する。
   */
  private async loadRulesForSource(
    accountId: string,
    calendarId: string,
  ): Promise<ReconcileRule[]> {
    if (!this.profileId) return [];

    const { results: ruleRows } = await this.env.DB.prepare(
      `SELECT DISTINCT br.id, br.profile_id, br.target_account_id, br.target_calendar_id, br.mode, br.created_at
       FROM block_rules br
       JOIN block_rule_sources brs ON brs.rule_id = br.id
       WHERE brs.account_id = ? AND brs.calendar_id = ? AND br.profile_id = ?`,
    )
      .bind(accountId, calendarId, this.profileId)
      .all<BlockRuleRow>();

    if (ruleRows.length === 0) return [];

    const placeholders = ruleRows.map(() => "?").join(", ");
    const { results: sourceRows } = await this.env.DB.prepare(
      `SELECT rule_id, account_id, calendar_id FROM block_rule_sources WHERE rule_id IN (${placeholders})`,
    )
      .bind(...ruleRows.map((row) => row.id))
      .all<BlockRuleSourceRow>();

    return aggregateBlockRules(ruleRows, sourceRows);
  }

  private async listSourceEvents(
    accountId: string,
    calendarId: string,
    window: ReconcileWindow,
  ): Promise<GoogleEventDTO[]> {
    const stub = this.env.USER_SYNC.getByName(accountId);
    const result = await stub.listEventsInWindow(
      accountId,
      calendarId,
      window.timeMin,
      window.timeMax,
    );
    if (!result.ok) {
      throw new Error(
        `listEventsInWindow failed for account=${accountId} calendar=${calendarId}: status=${result.status} ${result.error}`,
      );
    }
    return result.data;
  }

  private async loadMirrors(ruleId: string): Promise<BlockMirrorRow[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT rule_id, source_event_id, mirror_event_id, source_updated, created_at FROM block_mirrors WHERE rule_id = ?",
    )
      .bind(ruleId)
      .all<BlockMirrorRow>();
    return results;
  }

  private async createMirror(
    targetAccountId: string,
    targetCalendarId: string,
    body: MirrorEventBody,
  ): Promise<{ id: string; oooFallback: boolean }> {
    const stub = this.env.USER_SYNC.getByName(targetAccountId);
    const result = await stub.createMirrorEvent(targetAccountId, targetCalendarId, body);
    if (!result.ok) {
      throw new Error(
        `createMirrorEvent failed for account=${targetAccountId} calendar=${targetCalendarId}: status=${result.status} ${result.error}`,
      );
    }
    return result.data;
  }

  /**
   * カレンダーブロック機能 (docs/blocking.md 第4段階): outOfOffice ルールが Google に
   * 拒否されて busy にフォールバックしたかどうかを block_rules.ooo_fallback に記録する。
   * 設定 UI がこのフラグを見て「不在に非対応のため予定ありで作成しています」を表示する。
   * loadRulesForSource と同じ方針で profileId 未設定なら何もせず早期 return する
   * (profile 越境防止のクエリに profileId が必須なため)。
   */
  private async setRuleOooFallback(ruleId: string, value: boolean): Promise<void> {
    if (!this.profileId) return;
    await this.env.DB.prepare(
      "UPDATE block_rules SET ooo_fallback = ? WHERE id = ? AND profile_id = ?",
    )
      .bind(value ? 1 : 0, ruleId, this.profileId)
      .run();
  }

  private async patchMirrorTime(
    targetAccountId: string,
    targetCalendarId: string,
    mirrorEventId: string,
    start: GoogleEventDTO["start"],
    end: GoogleEventDTO["end"],
  ): Promise<void> {
    const stub = this.env.USER_SYNC.getByName(targetAccountId);
    const result = await stub.patchEventRaw(
      targetAccountId,
      targetCalendarId,
      mirrorEventId,
      start ?? {},
      end ?? {},
    );
    if (!result.ok) {
      throw new Error(
        `patchEventRaw failed for account=${targetAccountId} calendar=${targetCalendarId}: status=${result.status} ${result.error}`,
      );
    }
  }

  private async deleteMirror(
    targetAccountId: string,
    targetCalendarId: string,
    mirrorEventId: string,
  ): Promise<void> {
    const stub = this.env.USER_SYNC.getByName(targetAccountId);
    const result = await stub.deleteEvent(targetAccountId, targetCalendarId, mirrorEventId);
    if (!result.ok) {
      throw new Error(
        `deleteEvent failed for account=${targetAccountId} calendar=${targetCalendarId}: status=${result.status} ${result.error}`,
      );
    }
  }

  private async saveMirrorRow(row: BlockMirrorRow): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO block_mirrors (rule_id, source_event_id, mirror_event_id, source_updated, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        row.rule_id,
        row.source_event_id,
        row.mirror_event_id,
        row.source_updated,
        row.created_at,
      )
      .run();
  }

  private async updateMirrorRow(
    ruleId: string,
    sourceEventId: string,
    sourceUpdated: string | null,
  ): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE block_mirrors SET source_updated = ? WHERE rule_id = ? AND source_event_id = ?",
    )
      .bind(sourceUpdated, ruleId, sourceEventId)
      .run();
  }

  private async deleteMirrorRow(ruleId: string, sourceEventId: string): Promise<void> {
    await this.env.DB.prepare("DELETE FROM block_mirrors WHERE rule_id = ? AND source_event_id = ?")
      .bind(ruleId, sourceEventId)
      .run();
  }

  private async runSession(session: Session, lastEventId: number | null): Promise<void> {
    // hello = 接続 (再接続) 時は取りこぼしがあり得るので、クライアントは hello 受信時に
    // 選択中カレンダーを一巡 sync する仕様 (README/protocol.ts のコメント参照)。
    await session.writer.write(sseEvent(JSON.stringify({ type: "hello" } satisfies ServerEvent)));

    if (lastEventId !== null) {
      for (const buffered of this.ringBuffer.since(lastEventId)) {
        await session.writer.write(sseEvent(JSON.stringify(buffered.event), buffered.id));
      }
    }

    while (!session.closed) {
      await scheduler.wait(KEEP_ALIVE_INTERVAL_MS);
      if (session.closed) break;
      await session.writer.write(sseComment("keep-alive"));
    }
  }

  private closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    session.writer.close().catch(() => {});

    if (this.sessions.size === 0 && this.profileId) {
      const profileId = this.profileId;
      this.ctx.waitUntil(
        this.setPollingForProfile(profileId, false).catch((err) =>
          console.error(
            `ProfileHubDO: failed to stop polling fallback for profile ${profileId}`,
            err,
          ),
        ),
      );
    }
  }

  /**
   * このプロファイルに属する全アカウントの UserSyncDO へポーリングフォールバックの
   * 有効/無効を伝える。D1 で profile のアカウントを引いて各 DO の RPC を呼ぶだけの
   * シンプルな実装 (アカウント数は個人利用〜招待制規模なので並列呼び出しで十分)。
   */
  private async setPollingForProfile(profileId: string, enabled: boolean): Promise<void> {
    const { results } = await this.env.DB.prepare("SELECT id FROM accounts WHERE profile_id = ?")
      .bind(profileId)
      .all<{ id: string }>();

    await Promise.all(
      results.map((row) => {
        const stub = this.env.USER_SYNC.getByName(row.id);
        return enabled ? stub.enablePolling(row.id, profileId) : stub.disablePolling();
      }),
    );
  }
}
