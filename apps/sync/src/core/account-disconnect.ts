/**
 * 連携解除 (DELETE /api/account) の後始末: 「何を消すか」の判断と実行順序。
 *
 * D1/Google/DO には直接触れず、副作用は DisconnectDeps 経由で注入する
 * (core/block-orchestrate.ts と同じ流儀) — 実 Google/D1 なしで順序と判断を単体テスト
 * できるようにするため。実際の SQL / RPC の割り当ては routes/settings.ts 側にある。
 *
 * 背景 (2026-07-28): 解除は認可情報・表示カレンダー選択・DO の同期状態しか消しておらず、
 * watches 行と block_rules 系が残っていた。watches 行が残ると
 *  - Google 側の push 購読が生き続ける (解除したはずのカレンダーの更新通知が飛んでくる)
 *  - Cron の renewWatch (index.ts) が消えたアカウントの watch を延々と再登録しようとする
 * block_rules 系が残ると、存在しないアカウントを参照するルールがリコンサイルの度に失敗する。
 */

/** 解除対象アカウントが持っていた watch channel 1件 (stop に必要な最小情報)。 */
export interface DisconnectWatchRef {
  channelId: string;
  calendarId: string;
}

/** 掃除の判断に必要なルール1件ぶんの情報 (block_rules + block_rule_sources の集約)。 */
export interface BlockRuleCleanupInput {
  id: string;
  targetAccountId: string;
  sources: { accountId: string; calendarId: string }[];
}

/** planBlockRuleCleanup の結果。呼び出し元はこれをそのまま SQL に落とす。 */
export interface BlockRuleCleanupPlan {
  /** ルールごと削除する id (block_rules / block_rule_sources / block_mirrors の全行)。 */
  ruleIdsToDelete: string[];
  /** 生き残るルールから外す source 行 (block_rule_sources の1行)。 */
  sourcesToDetach: { ruleId: string; accountId: string; calendarId: string }[];
}

/**
 * 解除されたアカウント集合とルール一覧から、削除すべきルールと外すべき source を決める (純関数)。
 *
 * - target が解除された → **ルールごと削除**。書き込み先が消えた以上、ルールは成立しない。
 * - source の一部だけが解除された → **その source 行だけを外し、ルールは残す**。
 *   残る source があればルールは成立し続けるので、利用者が設定した「他のカレンダーからの
 *   ブロック」まで巻き添えで消すのは越権 (resolveDisconnectTargets の「勝手に昇格させない」
 *   という判断と同じ考え方)。加えて、外さずに残すと存在しないアカウントを参照する source が
 *   残り、リコンサイル時の listSourceEvents が必ず失敗してルール全体が動かなくなる
 *   (core/block-orchestrate.ts の reconcileRule はルール単位で try/catch する) ため、
 *   「残す」なら参照だけは必ず消す必要がある。
 * - source が0件になった → ルールも削除。source の無いルールは何もブロックしない = 無意味。
 *
 * なお、生き残ったルールが解除済み source の予定から作っていたミラーは、次回のリコンサイルで
 * 「source 側に存在しない予定のミラー」として削除計画に載る (block-reconcile.ts) ので、
 * ここで block_mirrors を個別に消す必要はない。
 */
export function planBlockRuleCleanup(
  disconnectedAccountIds: Iterable<string>,
  rules: BlockRuleCleanupInput[],
): BlockRuleCleanupPlan {
  const disconnected = new Set(disconnectedAccountIds);
  const plan: BlockRuleCleanupPlan = { ruleIdsToDelete: [], sourcesToDetach: [] };
  if (disconnected.size === 0) return plan;

  for (const rule of rules) {
    if (disconnected.has(rule.targetAccountId)) {
      plan.ruleIdsToDelete.push(rule.id);
      continue;
    }
    const affected = rule.sources.filter((source) => disconnected.has(source.accountId));
    if (affected.length === 0) continue;
    if (affected.length === rule.sources.length) {
      // 全 source が解除された = 残る source が無いのでルールごと削除する。
      plan.ruleIdsToDelete.push(rule.id);
      continue;
    }
    for (const source of affected) {
      plan.sourcesToDetach.push({
        ruleId: rule.id,
        accountId: source.accountId,
        calendarId: source.calendarId,
      });
    }
  }

  return plan;
}

/**
 * 連携解除の後始末が必要とする副作用一式。呼び出し元 (routes/settings.ts) が D1 / Google /
 * UserSyncDO RPC を注入する。
 */
export interface DisconnectDeps {
  /** そのアカウントに紐づく watch channel を全部返す。 */
  listWatches(accountId: string): Promise<DisconnectWatchRef[]>;
  /** Google の channels.stop を呼び、対応する watches 行を消す (best-effort)。 */
  stopWatch(accountId: string, watch: DisconnectWatchRef): Promise<void>;
  /** refresh token を Google で revoke する (best-effort)。 */
  revokeToken(accountId: string): Promise<void>;
  /** UserSyncDO の同期状態 (トークンキャッシュ・syncToken・alarm) を消す。 */
  clearSyncState(accountId: string): Promise<void>;
  /** accounts / account_visible_calendars / account_calendar_prefs / watches の行を消す。 */
  deleteAccountRows(accountId: string): Promise<void>;
  /** プロファイル内の全ブロックルール (target + sources) を返す。 */
  loadBlockRules(): Promise<BlockRuleCleanupInput[]>;
  /** planBlockRuleCleanup の結果を D1 に適用する。 */
  applyBlockRuleCleanup(plan: BlockRuleCleanupPlan): Promise<void>;
}

/**
 * 解除対象アカウント群の後始末を、以下の順序で行う。
 *
 * 1. **watch の停止** — Google の channels.stop には有効な access token が要る。access token は
 *    refresh token から取るので、**revoke より先**に呼ばないと購読を止められなくなる
 *    (revoke 後は token が取れず、Google 側に購読だけが生き残る)。同じ理由で
 *    clearSyncState (DO の token_cache を消す) や accounts 行の削除よりも先。
 * 2. **revoke** — 認可の取り消し。
 * 3. **clearSyncState** — DO 側の同期状態。
 * 4. **行削除** — D1 の accounts 系 + watches。
 *
 * 1〜3 は best-effort: 失敗しても握って続行し、4 の行削除は必ず行う。「解除できない」状態に
 * 利用者を閉じ込めないため (既存の revoke 失敗時の扱い・disableWatch の流儀と同じ)。
 *
 * 最後に、解除された全アカウントを踏まえてブロックルールを1回だけ掃除する
 * (アカウント単位ではなくプロファイル単位の判断 — オーナー解除で束ごと消えるとき、
 * 「1件目の解除では生き残るが2件目で source が0件になる」ルールを正しく扱うため)。
 */
export async function disconnectAccounts(
  accountIds: string[],
  deps: DisconnectDeps,
): Promise<void> {
  for (const accountId of accountIds) {
    // --- 1. watch の停止 (revoke より前) ---
    let watches: DisconnectWatchRef[] = [];
    try {
      watches = await deps.listWatches(accountId);
    } catch (err) {
      console.warn(`account deletion: failed to list watches for account ${accountId}`, err);
    }
    for (const watch of watches) {
      try {
        await deps.stopWatch(accountId, watch);
      } catch (err) {
        console.warn(
          `account deletion: failed to stop watch channel ${watch.channelId} for account ${accountId} (continuing)`,
          err,
        );
      }
    }

    // --- 2. revoke ---
    try {
      await deps.revokeToken(accountId);
    } catch (err) {
      console.warn(`account deletion: failed to revoke token for account ${accountId}`, err);
    }

    // --- 3. DO の同期状態 ---
    try {
      await deps.clearSyncState(accountId);
    } catch (err) {
      console.warn(`account deletion: failed to clear DO sync state for account ${accountId}`, err);
    }

    // --- 4. 行削除 (ここだけは失敗を握らない: 消えないと解除にならない) ---
    await deps.deleteAccountRows(accountId);
  }

  const rules = await deps.loadBlockRules();
  const plan = planBlockRuleCleanup(accountIds, rules);
  if (plan.ruleIdsToDelete.length === 0 && plan.sourcesToDetach.length === 0) return;
  await deps.applyBlockRuleCleanup(plan);
}
