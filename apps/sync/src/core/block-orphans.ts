import type {
  BlockMirrorCleanupItem,
  BlockMirrorCleanupRequest,
  CalendarListEntryDTO,
  GoogleEventDTO,
  OrphanMirrorDTO,
} from "@kichijitsu/shared";
import { isMirrorEvent, MIRROR_RULE_KEY, MIRROR_SOURCE_KEY } from "./block-reconcile";
import { isNonEmptyString } from "./validation";

/**
 * 孤児ミラー掃除 (docs/blocking.md「将来やるならこれ」、2026-08-04)。
 *
 * ルール削除・target 変更・連携解除のいずれかを経て対応表 (block_mirrors) からはぐれ、
 * コピー先カレンダーに残り続ける「予定あり」ミラーを、対応表に頼らず target カレンダーの
 * 走査だけで見つけて片付ける独立した導線 (GET /api/block-mirrors/orphans /
 * POST /api/block-mirrors/cleanup、routes/block-mirrors.ts)。
 *
 * このファイルが持つのは判定ロジックだけ (副作用なしの純関数)。Google 呼び出しは
 * core/scan-mirror-events.ts (走査) と core/get-event.ts (削除前再検証) にある。
 */

/** block_rules の1行を、この機能の判定に要る部分だけに絞った参照。 */
export interface LiveMirrorRuleRef {
  id: string;
  targetAccountId: string;
  targetCalendarId: string;
}

/** (accountId, calendarId) の組み合わせキー。block-rules.ts の重複判定キーと同じ発想 (NUL 区切り)。 */
function targetKey(accountId: string, calendarId: string): string {
  return `${accountId}\u0000${calendarId}`;
}

/**
 * ルール群を (target account, target calendar) → 生きているルール id の集合、に固める。
 * 同じ target を持つルールは複数あり得るので Set にする。
 */
export function indexLiveRuleIds(rules: LiveMirrorRuleRef[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const rule of rules) {
    const key = targetKey(rule.targetAccountId, rule.targetCalendarId);
    const existing = index.get(key);
    if (existing) {
      existing.add(rule.id);
    } else {
      index.set(key, new Set([rule.id]));
    }
  }
  return index;
}

/**
 * classifyMirrorState が返す分類。POST /api/block-mirrors/cleanup の再検証が「なぜ削除しなかったか」
 * の理由文字列を組み立てるのに使う (routes/block-mirrors.ts)。
 */
export type MirrorState = "orphan" | "not_a_mirror" | "cancelled" | "alive";

/**
 * 予定1件が孤児ミラーかどうかを判定する、この機能の唯一の判定ロジック (純関数)。
 * GET /api/block-mirrors/orphans (一覧の抽出、extractOrphanMirrors) と
 * POST /api/block-mirrors/cleanup (削除前の再検証、routes/block-mirrors.ts) の**両方**が
 * これを通る ―― 判定基準を1箇所にすることで、一覧と削除の基準がずれて「一覧には出たのに
 * 消せない」「一覧に出ないのに削除できてしまう」が起きないようにする。
 *
 * 判定基準 (docs/blocking.md「将来やるならこれ」の実装):
 * カレンダー C (アカウント A) で見つかった kichijitsuMirror=1 の予定は、
 * **「このプロファイルに target_account_id===A かつ target_calendar_id===C かつ
 * id===その予定の kichijitsuRule であるルールが存在する」場合にのみ「生きている」**とみなす。
 * それ以外はすべて孤児。
 *
 * この定義を選んだ理由:
 * - ルール削除・target 変更・連携解除のどれで出た孤児かを区別せず片付けられる
 *   (どの経路でも「対応する生きたルールが無い」という結果は同じになるため、経路ごとに
 *   別の判定を持つ必要が無い)
 * - **リコンサイラと取り合いにならない**。Google への insert 成功直後に D1 書き込みが
 *   失敗したミラーは block_mirrors に無いが、block-orchestrate.ts の loadAdoptableMirrors /
 *   reconcileRule が次回「採用」して回収する (block-reconcile.ts の MIRROR_RULE_KEY の
 *   コメント参照)。この定義ならそのミラーは「生きている」側 (target 一致 + ルール id 一致) に
 *   入るので、掃除機能が先に消してしまってリコンサイラが作り直す、という無駄な往復が起きない。
 *   ―― **block_mirrors テーブルを一切見ず、block_rules だけで判定する**のはこのため
 * - kichijitsuRule を持たないミラー (もしあれば、旧世代や異常系) は誰も管理できないので
 *   孤児側になるのが正しい
 *
 * cancelled (Google 上で既に削除済み) は孤児として返さない ―― 掃除の対象は「Google に
 * まだ残っている」予定であり、既に消えているものを一覧に出しても選べる操作が無い。
 */
export function classifyMirrorState(
  accountId: string,
  calendarId: string,
  event: GoogleEventDTO,
  liveRuleIds: Map<string, Set<string>>,
): MirrorState {
  if (!isMirrorEvent(event)) return "not_a_mirror";
  if (event.status === "cancelled") return "cancelled";
  const ruleId = event.extendedProperties?.private?.[MIRROR_RULE_KEY];
  if (!ruleId) return "orphan";
  const liveSet = liveRuleIds.get(targetKey(accountId, calendarId));
  return liveSet?.has(ruleId) ? "alive" : "orphan";
}

/** classifyMirrorState(...) === "orphan" の bool 版 (呼び出し側の大半はこれで十分)。 */
export function isOrphanMirror(
  accountId: string,
  calendarId: string,
  event: GoogleEventDTO,
  liveRuleIds: Map<string, Set<string>>,
): boolean {
  return classifyMirrorState(accountId, calendarId, event, liveRuleIds) === "orphan";
}

/** start/end のうち dateTime/date だけを写す (timeZone 等は API 応答に含めない、無内容原則寄りの最小化)。 */
function toTimeField(field: GoogleEventDTO["start"]): { dateTime?: string; date?: string } {
  return {
    ...(field?.dateTime ? { dateTime: field.dateTime } : {}),
    ...(field?.date ? { date: field.date } : {}),
  };
}

/**
 * 走査で得た1カレンダーぶんの予定群から孤児ミラーだけを、GET /api/block-mirrors/orphans が
 * 返す形 (OrphanMirrorDTO) に変換する。isOrphanMirror を通すので、mirror でない予定・
 * cancelled・生きているミラーは自動的に除かれる (Google 側の privateExtendedProperty
 * 絞り込みが期待通り働かなかった場合の二重チェックも兼ねる ―― google/scan-mirror-events.ts
 * のコメント参照)。
 */
export function extractOrphanMirrors(
  accountId: string,
  calendarId: string,
  events: GoogleEventDTO[],
  liveRuleIds: Map<string, Set<string>>,
): OrphanMirrorDTO[] {
  const orphans: OrphanMirrorDTO[] = [];
  for (const event of events) {
    if (!isOrphanMirror(accountId, calendarId, event, liveRuleIds)) continue;
    const props = event.extendedProperties?.private;
    orphans.push({
      accountId,
      calendarId,
      eventId: event.id,
      start: toTimeField(event.start),
      end: toTimeField(event.end),
      ruleId: props?.[MIRROR_RULE_KEY] ?? null,
      sourceEventId: props?.[MIRROR_SOURCE_KEY] ?? null,
    });
  }
  return orphans;
}

/**
 * GET /api/block-mirrors/orphans の走査対象を「書き込み可能なカレンダー」(accessRole が
 * owner/writer) に絞る判定。mirror は必ずこの2つのどちらかの権限で作られる (reader/
 * freeBusyReader では events.insert がそもそも通らない) ので、それ以外を走査しても
 * 孤児は出ようがなく、無駄な Google 呼び出しを増やすだけ。
 *
 * accessRole が無い (旧クライアント/取得失敗時の後方互換、CalendarListEntryDTO のコメント参照) は
 * 「他のカレンダー」側 = 書き込み不可として扱う ―― apps/web/src/sync/calendarGroups.ts と
 * 同じ倒し方 (undefined を安全側 = 書けない側に倒す)。
 */
export function isWritableCalendar(calendar: CalendarListEntryDTO): boolean {
  return calendar.accessRole === "owner" || calendar.accessRole === "writer";
}

/** POST /api/block-mirrors/cleanup の1件あたりの検証 (accountId/calendarId/eventId が非空文字列)。 */
function isValidCleanupItem(value: unknown): value is BlockMirrorCleanupItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.accountId) &&
    isNonEmptyString(candidate.calendarId) &&
    isNonEmptyString(candidate.eventId)
  );
}

/**
 * POST /api/block-mirrors/cleanup のボディ検証。items は配列で、各要素が
 * {accountId, calendarId, eventId} (すべて非空文字列)。件数の上限・空配列の扱いは
 * ここでは見ない (400 の理由を区別できるよう routes/block-mirrors.ts 側で個別に判定する)。
 */
export function isValidBlockMirrorCleanupRequest(
  body: unknown,
): body is BlockMirrorCleanupRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;
  if (!Array.isArray(candidate.items)) return false;
  return candidate.items.every(isValidCleanupItem);
}

/**
 * 1リクエストで削除できる件数の上限。この API は利用者が明示的に押す「掃除」ボタンからしか
 * 呼ばれない想定だが、1件ごとに events.get (再検証) → events.delete の最大2往復を直列に行う
 * ため (routes/block-mirrors.ts)、際限なく受けると1リクエストの処理時間と Google API への
 * 呼び出し数の両方が青天井になる。500 件を超える分はクライアント側で複数回に分けて呼んでもらう
 * (「大量ページングへの対処」は分割呼び出しに寄せ、サーバー側で内部リトライ/キューは持たない ――
 * この機能の呼び出し頻度・件数規模ではその複雑さに見合わない)。
 */
export const MAX_CLEANUP_ITEMS = 500;
