import type { BlockMode, GoogleEventDTO } from "@kichijitsu/shared";
import {
  buildMirrorEventBody,
  indexMirrorsBySourceEvent,
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
  /**
   * target カレンダーの予定を同じウィンドウで取得する (中身は listSourceEvents と同じ
   * events.list)。孤児 mirror の回収 (reconcileRule のコメント参照) にだけ使うので、
   * 呼ぶのは新規作成が必要な回に限る。
   */
  listTargetEvents(
    targetAccountId: string,
    targetCalendarId: string,
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

/**
 * 1ルールぶんのリコンサイル。
 *
 * **ミラー作成の不変条件** (applyMirrorDeletions の doc と対になる): *Google 上にミラーが
 * 存在するなら、それを指す block_mirrors の行が残っているか、そのミラーが確実に消えているか、
 * どちらかである*。作成側でこれを破るのが「events.insert は成功したが D1 書き込みが失敗した」
 * ケースで、放置すると行の無いミラーが残る。後始末の経路 (applyMirrorDeletions /
 * deleteRuleMirrors) はどちらも block_mirrors を走査するので、その予定は二度と辿れない
 * 孤児になり、しかも次のリコンサイルが同じ source をまた toCreate に載せるため
 * **リコンサイルのたびに孤児が増える**。二段構えで防ぐ:
 *
 * 1. **補償削除** — 行が書けなかったら、今作ったミラーを Google から消して「行も予定も
 *    無い」状態へ巻き戻す。次のリコンサイルが素直に作り直せる。
 * 2. **採用 (回収)** — ミラー自身に由来 (rule_id / source_event_id) を書き込んである
 *    (buildMirrorEventBody) ので、補償削除まで失敗した場合や、insert 直後にワーカーが
 *    落ちて catch すら通らなかった場合でも、次のリコンサイルが target カレンダーを見て
 *    孤児を見つけ、作り直す代わりにそれを指す行を書いて回収する。**孤児は増えず1件に収束する**。
 *
 * 採用のための target 一覧取得は toCreate が1件以上ある回だけ行う (何も作る必要が無い
 * 定常状態では Google 呼び出しは増えない)。
 */
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

  const adoptable: Map<string, string> =
    plan.toCreate.length > 0 ? await loadAdoptableMirrors(rule, window, deps) : new Map();

  let anyOooFallback = false;
  let created = 0;
  for (const source of plan.toCreate) {
    // 回収 (採用): 行は無いが Google 側に前回作りかけた mirror が残っている場合は、
    // 作り直さずにその mirror を指す行を書いて対応表に取り込む。
    const orphanMirrorId = adoptable.get(source.id);
    if (orphanMirrorId !== undefined) {
      try {
        await deps.saveMirrorRow({
          rule_id: rule.id,
          source_event_id: source.id,
          mirror_event_id: orphanMirrorId,
          // 孤児になった後に source の時刻が変わっている可能性があるので「未同期」として
          // 記録する。次のリコンサイルで必ず toPatch に載り、時刻がそこで揃う。
          source_updated: null,
          created_at: deps.now(),
        });
      } catch (err) {
        // 行が書けなければ孤児のまま。次のリコンサイルでまた採用を試みるだけなので、
        // 予定が二重になることはない (何度採用しても同じ mirror を指す)。
        console.error(
          `reconcileSourceChange: adopting orphan mirror failed for rule=${rule.id} source=${source.id}`,
          err,
        );
      }
      continue;
    }

    try {
      const body = buildMirrorEventBody(source, rule.mode, rule.id);
      const { id: mirrorEventId, oooFallback } = await deps.createMirror(
        rule.target.accountId,
        rule.target.calendarId,
        body,
      );
      created += 1;
      if (oooFallback) {
        anyOooFallback = true;
      }
      // Google 作成が成功して初めて D1 に記録する (create 失敗時に行を残して不整合にしないため)。
      try {
        await deps.saveMirrorRow({
          rule_id: rule.id,
          source_event_id: source.id,
          mirror_event_id: mirrorEventId,
          source_updated: source.updated ?? null,
          created_at: deps.now(),
        });
      } catch (err) {
        // 逆向きの失敗 (Google には出来たが行が書けない)。補償削除で「行も予定も無い」状態に
        // 巻き戻す — ここで諦めると行の無い mirror = 孤児が残り、次のリコンサイルが同じ
        // source をまた toCreate に載せるので毎回増える。
        console.error(
          `reconcileSourceChange: saving mirror row failed for rule=${rule.id} source=${source.id}, deleting the mirror just created`,
          err,
        );
        try {
          await deps.deleteMirror(
            rule.target.accountId,
            rule.target.calendarId,
            mirrorEventId,
          );
        } catch (deleteErr) {
          // 補償削除も失敗 = 孤児が1件残る。ただし mirror 自身が由来 (rule/source id) を
          // 持っているので、次のリコンサイルが上の採用処理で回収する (増え続けはしない)。
          console.error(
            `reconcileSourceChange: compensating delete failed for rule=${rule.id} mirror=${mirrorEventId} (will be adopted on the next reconcile)`,
            deleteErr,
          );
        }
      }
    } catch (err) {
      console.error(
        `reconcileSourceChange: create mirror failed for rule=${rule.id} source=${source.id}`,
        err,
      );
    }
  }

  // 第4段階: outOfOffice ルールで実際に createMirror を呼んだ回だけ ooo_fallback を
  // 更新する。全 mirror が既存済みで toCreate が空の回や、toCreate が全部「既存の孤児の
  // 採用」で済んだ回は Google に body を送っていない = フォールバックしたか否かの新しい
  // 情報が無いので、既存の DB 上の値を保持したまま何もしない (すでに記録済みのフラグを
  // 不用意に上書きしないため)。busy ルールでは常に呼ばない。D1 書き込みの失敗が
  // リコンサイル全体を止めないよう try/catch で分離する
  // (このファイルの他の箇所と同じエラー分離の流儀)。
  if (rule.mode === "outOfOffice" && created > 0) {
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

  await applyMirrorDeletions(rule.id, rule.target, plan.toDelete, deps);
}

/**
 * target カレンダーに残っている「このルールのミラー」を source_event_id → mirror_event_id で
 * 引ける形にする (対応表に載っていない孤児を回収するため)。
 *
 * 取得に失敗しても例外にしない: 採用は回収のための上積みであり、引けなければ最悪これまで
 * 通り新規作成するだけ (孤児が1件残るが、次のリコンサイルで再び採用の機会がある)。ここで
 * 投げるとルール全体のリコンサイルが止まってしまい、割に合わない。
 */
async function loadAdoptableMirrors(
  rule: ReconcileRule,
  window: ReconcileWindow,
  deps: ReconcileDeps,
): Promise<Map<string, string>> {
  try {
    const targetEvents = await deps.listTargetEvents(
      rule.target.accountId,
      rule.target.calendarId,
      window,
    );
    return indexMirrorsBySourceEvent(targetEvents, rule.id);
  } catch (err) {
    console.error(
      `reconcileSourceChange: listing target events failed for rule=${rule.id} (skipping orphan adoption)`,
      err,
    );
    return new Map();
  }
}

/** ミラー削除だけが要る経路 (ルール削除) 用に、ReconcileDeps から delete 系だけを切り出した部分集合。 */
export type MirrorDeleteDeps = Pick<ReconcileDeps, "deleteMirror" | "deleteMirrorRow">;

/** applyMirrorDeletions の結果。呼び出し元のログ用 (失敗しても例外は投げない)。 */
export interface MirrorDeleteResult {
  deleted: number;
  failed: number;
}

/**
 * 削除プラン (reconcileBlockRule の toDelete) を実行する。Google から mirror を消し、
 * 成功して初めて対応表の行を消す (Google 削除が失敗した行を先に消すと、二度と辿れない
 * 孤児予定になるため)。
 *
 * **best-effort**: 1件の失敗は握って残りを続ける — 1つの予定 (既に手で消された・権限が
 * 変わった等) が原因で後始末全体が止まると、利用者が「削除できない」状態に閉じ込められる。
 */
async function applyMirrorDeletions(
  ruleId: string,
  target: { accountId: string; calendarId: string },
  mirrors: BlockMirrorRow[],
  deps: MirrorDeleteDeps,
): Promise<MirrorDeleteResult> {
  const result: MirrorDeleteResult = { deleted: 0, failed: 0 };
  for (const mirror of mirrors) {
    try {
      await deps.deleteMirror(target.accountId, target.calendarId, mirror.mirror_event_id);
      await deps.deleteMirrorRow(ruleId, mirror.source_event_id);
      result.deleted += 1;
    } catch (err) {
      result.failed += 1;
      // リコンサイル経由とルール削除経由の双方から呼ばれるので、ログの主語は操作名にする。
      console.error(
        `delete mirror failed for rule=${ruleId} mirror=${mirror.mirror_event_id}`,
        err,
      );
    }
  }
  return result;
}

/**
 * ルール削除 (DELETE /api/block-rules で deleteMirrors:true) の後始末: そのルールが作った
 * ミラー予定を Google から全部消す。
 *
 * 「source が1件も無くなった状態へのリコンサイル」と同じことなので、判断は既存の純関数
 * reconcileBlockRule に空の source 集合を渡して得る (toDelete = 全 mirror)。実行も
 * 通常のリコンサイルと同じ applyMirrorDeletions を通す — 削除の順序と best-effort の
 * 扱いを1箇所に保つため。
 *
 * 例外は投げない。呼び出し元 (routes/settings.ts) は結果に関わらずルール行を消す:
 * 「Google の予定が消せないせいでルールも消せない」状態を作らないため。
 */
export async function deleteRuleMirrors(
  ruleId: string,
  target: { accountId: string; calendarId: string },
  mirrors: BlockMirrorRow[],
  deps: MirrorDeleteDeps,
): Promise<MirrorDeleteResult> {
  const plan = reconcileBlockRule([], mirrors);
  return applyMirrorDeletions(ruleId, target, plan.toDelete, deps);
}
