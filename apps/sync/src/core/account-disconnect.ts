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
 *   なお削除されるルールが Google 上に作ったミラー予定は残す (target が生きていて消せる場合でも)
 *   — 理由は planReconcileTriggers の「原則との関係」を参照。
 *
 * なお、生き残ったルールが解除済み source の予定から作っていたミラーは、リコンサイルさえ
 * 走れば「source 側に存在しない予定のミラー」として削除計画に載る (block-reconcile.ts) ので、
 * ここで block_mirrors を個別に消す必要はない。ただし**そのリコンサイルは自動では起きない**
 * — 起点は残っている source への notifyChanged だけで、解除されたカレンダーはもう発火しない。
 * だから解除の最後に planReconcileTriggers で自分から起こす (下記参照)。
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

/** リコンサイルの起点にする「解除後も残っている source カレンダー」1件。 */
export interface ReconcileTrigger {
  accountId: string;
  calendarId: string;
}

/**
 * 解除後も生き残るルールについて、リコンサイルの起点にできる「残っている source」を選ぶ (純関数)。
 *
 * **なぜ要るか**: リコンサイルに到達する唯一の経路は source カレンダーへの変更通知
 * (ProfileHubDO.notifyChanged) で、解除されたカレンダーはもう二度と発火しない。放っておくと
 * 「外したアカウント由来のミラー」は、無関係な別 source がたまたま変わるまで target に残り続ける。
 * そこで解除の最後に、残っている source を起点にして自分でリコンサイルを起こす。ミラーは
 * 「source 側に存在しない予定のミラー」として削除計画に載って片付く (planBlockRuleCleanup の
 * コメント参照)。
 *
 * 対象は「source の一部だけが外れて生き残るルール」だけ:
 * - target が解除された / 全 source が解除された → ルールごと消えるので起こす意味が無い。
 *   ルールと一緒に block_mirrors の行も消える (applyBlockRuleCleanup) ため、リコンサイルが
 *   見るミラーがそもそも残らない。そのミラー予定は Google 上に残る — 理由は下記の原則で
 *   あって、target の認可が生きているかどうかではない (routes/settings.ts の
 *   applyBlockRuleCleanup のコメント参照)
 * - 何も外れなかったルール → 変えるものが無い
 *
 * **原則との関係**: 「Google 上の予定を消すのは利用者が明示的に選んだときだけ」
 * (docs/blocking.md「後始末」) と、ここでミラーが消えることは矛盾しない。生き残るルールは
 * block_mirrors の行も生き残るので、**放っておいても次にどれかの source が変わった時点で
 * 同じ削除が起きる** — 起点を用意するのは「消すか否か」ではなく「いつ消えるか」を変えている
 * だけで、削除自体はルールを作った時点で利用者が選んだ「元の予定に追従する」の一部である。
 * 対してルールごと消える場合は対応表の行ごと消えて二度と辿れなくなるので、そこで消すことは
 * 追従の続きではなく新しい破壊操作になる。だから「消しますか」を聞ける瞬間の無い解除では
 * 消さない (聞ける瞬間があるルール削除だけがチェックボックスで選ばせる)。
 *
 * 同じ source を複数ルールが共有していても1回だけ起こす — 1回のリコンサイルはその source を
 * 持つ全ルールを見る (block-orchestrate.ts の reconcileSourceChange) ので、重複は無駄なだけ。
 */
export function planReconcileTriggers(
  disconnectedAccountIds: Iterable<string>,
  rules: BlockRuleCleanupInput[],
): ReconcileTrigger[] {
  const disconnected = new Set(disconnectedAccountIds);
  const triggers: ReconcileTrigger[] = [];
  if (disconnected.size === 0) return triggers;

  const seen = new Set<string>();
  for (const rule of rules) {
    if (disconnected.has(rule.targetAccountId)) continue;
    const remaining = rule.sources.filter((source) => !disconnected.has(source.accountId));
    // 残る source が無い = ルールごと削除。全部残る = このルールは無関係。
    if (remaining.length === 0 || remaining.length === rule.sources.length) continue;

    const source = remaining[0]!;
    // 区切りは U+0000 (NUL) — id に現れない文字なのでキー衝突が起きない。生バイトを書くと git が
    // バイナリ扱いするのでエスケープ表記で書く (profile-hub-do.ts の reconcileChains と同じ)。
    const key = `${source.accountId}\u0000${source.calendarId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    triggers.push({ accountId: source.accountId, calendarId: source.calendarId });
  }

  return triggers;
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
  /**
   * その source カレンダーが変わったことにして、ブロックルールのリコンサイルを起こす
   * (実体は ProfileHubDO.notifyChanged)。best-effort — 失敗しても解除は成立させる。
   */
  reconcileFromSource(trigger: ReconcileTrigger): Promise<void>;
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
 *
 * 掃除の後、生き残ったルールについてはリコンサイルを起こして、外したカレンダー由来の
 * ミラーをその場で片付ける (planReconcileTriggers 参照)。**D1 の掃除より後**であることが
 * 重要 — 先に起こすと、まだ外れていない解除済み source を読みに行って必ず失敗する。
 * ここも best-effort: 失敗しても解除自体は成立させる (残るのはミラー予定だけで、次に
 * その source が変わったときに片付く)。
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

  for (const trigger of planReconcileTriggers(accountIds, rules)) {
    try {
      await deps.reconcileFromSource(trigger);
    } catch (err) {
      console.warn(
        `account deletion: failed to trigger block reconcile for ${trigger.accountId}/${trigger.calendarId} (mirrors from the disconnected calendar stay until the next change)`,
        err,
      );
    }
  }
}
