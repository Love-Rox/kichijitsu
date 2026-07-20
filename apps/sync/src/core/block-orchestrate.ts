import type { BlockMode, GoogleEventDTO } from "@kichijitsu/shared";
import {
  buildMirrorEventBody,
  reconcileBlockRule,
  type BlockMirrorRow,
  type MirrorEventBody,
} from "./block-reconcile";

/** RFC3339 の期間ウィンドウ。listSourceEvents に渡すリコンサイル対象範囲。 */
export interface ReconcileWindow {
  timeMin: string;
  timeMax: string;
}

/**
 * リコンサイル対象の1ルール。BlockRuleDTO (core/block-rules.ts) と同形だが、この層は
 * D1/RPC に依存しないようあえて独立した型として定義する (ReconcileDeps が返す形)。
 */
export interface ReconcileRule {
  id: string;
  sources: { accountId: string; calendarId: string }[];
  target: { accountId: string; calendarId: string };
  mode: BlockMode;
}

/**
 * reconcileSourceChange が要求する副作用一式。呼び出し元 (ProfileHubDO) が D1 と
 * UserSyncDO RPC を注入し、このファイル自体は純粋なオーケストレーション判断だけを持つ
 * (実 Google/D1 なしで単体テストするための安全網)。
 */
export interface ReconcileDeps {
  /** (accountId, calendarId) を source に持つ、このプロファイルのルール群を返す。 */
  loadRulesForSource(accountId: string, calendarId: string): Promise<ReconcileRule[]>;
  listSourceEvents(
    accountId: string,
    calendarId: string,
    window: ReconcileWindow,
  ): Promise<GoogleEventDTO[]>;
  loadMirrors(ruleId: string): Promise<BlockMirrorRow[]>;
  /**
   * mirror を作成する。返り値の `id` は作成された mirror event id。`oooFallback` は
   * 第4段階: mode='outOfOffice' の body を送ったが Google に拒否され (Workspace の
   * primary カレンダー限定機能のため)、eventType を外した busy body で作り直した場合に
   * true になる。
   */
  createMirror(
    targetAccountId: string,
    targetCalendarId: string,
    body: MirrorEventBody,
  ): Promise<{ id: string; oooFallback: boolean }>;
  patchMirrorTime(
    targetAccountId: string,
    targetCalendarId: string,
    mirrorEventId: string,
    start: GoogleEventDTO["start"],
    end: GoogleEventDTO["end"],
  ): Promise<void>;
  deleteMirror(
    targetAccountId: string,
    targetCalendarId: string,
    mirrorEventId: string,
  ): Promise<void>;
  saveMirrorRow(row: BlockMirrorRow): Promise<void>;
  updateMirrorRow(
    ruleId: string,
    sourceEventId: string,
    sourceUpdated: string | null,
  ): Promise<void>;
  deleteMirrorRow(ruleId: string, sourceEventId: string): Promise<void>;
  /**
   * カレンダーブロック機能 (docs/blocking.md 第4段階): mode='outOfOffice' のルールが
   * Google に拒否されて busy にフォールバックしたかどうかを記録する。設定 UI の
   * 「不在に非対応のため予定ありで作成しています」注記表示に使う。
   */
  setRuleOooFallback(ruleId: string, value: boolean): Promise<void>;
  now(): number;
}

/**
 * source カレンダーの変更 (webhook/alarm 起点、docs/blocking.md 第3段階) をきっかけに、
 * その (accountId, calendarId) を source に持つ全ルールをリコンサイルする。
 *
 * 適用順序:
 * 1. loadRulesForSource でルール群を取得 (0件なら即 return — 大半の変更通知はここで終わる)
 * 2. ルールごとに、全 source calendar のイベントを結合し reconcileBlockRule (純関数、
 *    block-reconcile.ts) で create/patch/delete の差分を計算
 * 3. plan の各操作を実行: Google 書き込みが成功して初めて対応する D1 行を書く
 *    (create 失敗なら saveMirrorRow しない、patch/delete も同様) — 不整合を作らないため
 *
 * エラー分離: 1つの操作の失敗や1ルールの失敗が他を巻き込まないよう try/catch し
 * console.error で継続する (既存 alarm ループの流儀に合わせる)。
 *
 * ループ防止の不変条件: mirror は target カレンダーに kichijitsuMirror=1 付きで作られる。
 * target が別ルールの source でもあり得るが、reconcileBlockRule が isMirrorEvent で
 * mirror 自身を source 集合から除外するため、mirror が別ルールの新たな source として
 * 拾われて無限に増殖することはない (block-reconcile.ts 参照)。
 */
export async function reconcileSourceChange(
  accountId: string,
  calendarId: string,
  window: ReconcileWindow,
  deps: ReconcileDeps,
): Promise<void> {
  let rules: ReconcileRule[];
  try {
    rules = await deps.loadRulesForSource(accountId, calendarId);
  } catch (err) {
    console.error(
      `reconcileSourceChange: failed to load rules for source account=${accountId} calendar=${calendarId}`,
      err,
    );
    return;
  }

  if (rules.length === 0) return;

  for (const rule of rules) {
    try {
      await reconcileRule(rule, window, deps);
    } catch (err) {
      // 1ルールの失敗が他ルールを止めない。
      console.error(`reconcileSourceChange: rule ${rule.id} failed`, err);
    }
  }
}

async function reconcileRule(
  rule: ReconcileRule,
  window: ReconcileWindow,
  deps: ReconcileDeps,
): Promise<void> {
  const sourceEventLists = await Promise.all(
    rule.sources.map((source) =>
      deps.listSourceEvents(source.accountId, source.calendarId, window),
    ),
  );
  const sourceEvents = sourceEventLists.flat();

  const mirrors = await deps.loadMirrors(rule.id);
  const plan = reconcileBlockRule(sourceEvents, mirrors);

  let anyOooFallback = false;
  for (const source of plan.toCreate) {
    try {
      const body = buildMirrorEventBody(source, rule.mode);
      const { id: mirrorEventId, oooFallback } = await deps.createMirror(
        rule.target.accountId,
        rule.target.calendarId,
        body,
      );
      if (oooFallback) {
        anyOooFallback = true;
      }
      // Google 作成が成功して初めて D1 に記録する (create 失敗時に行を残して不整合にしないため)。
      await deps.saveMirrorRow({
        rule_id: rule.id,
        source_event_id: source.id,
        mirror_event_id: mirrorEventId,
        source_updated: source.updated ?? null,
        created_at: deps.now(),
      });
    } catch (err) {
      console.error(
        `reconcileSourceChange: create mirror failed for rule=${rule.id} source=${source.id}`,
        err,
      );
    }
  }

  // 第4段階: outOfOffice ルールで toCreate が実際に1件以上あった回だけ ooo_fallback を
  // 更新する。全 mirror が既存済みで toCreate が空の回は既存の DB 上の値を保持したまま
  // 何もしない (すでに記録済みのフラグを不用意に上書きしないため)。busy ルールでは常に
  // 呼ばない。D1 書き込みの失敗がリコンサイル全体を止めないよう try/catch で分離する
  // (このファイルの他の箇所と同じエラー分離の流儀)。
  if (rule.mode === "outOfOffice" && plan.toCreate.length > 0) {
    try {
      await deps.setRuleOooFallback(rule.id, anyOooFallback);
    } catch (err) {
      console.error(`reconcileSourceChange: setRuleOooFallback failed for rule=${rule.id}`, err);
    }
  }

  for (const { mirror, source } of plan.toPatch) {
    try {
      await deps.patchMirrorTime(
        rule.target.accountId,
        rule.target.calendarId,
        mirror.mirror_event_id,
        source.start,
        source.end,
      );
      await deps.updateMirrorRow(rule.id, mirror.source_event_id, source.updated ?? null);
    } catch (err) {
      console.error(
        `reconcileSourceChange: patch mirror failed for rule=${rule.id} source=${source.id}`,
        err,
      );
    }
  }

  for (const mirror of plan.toDelete) {
    try {
      await deps.deleteMirror(
        rule.target.accountId,
        rule.target.calendarId,
        mirror.mirror_event_id,
      );
      await deps.deleteMirrorRow(rule.id, mirror.source_event_id);
    } catch (err) {
      console.error(
        `reconcileSourceChange: delete mirror failed for rule=${rule.id} mirror=${mirror.mirror_event_id}`,
        err,
      );
    }
  }
}
