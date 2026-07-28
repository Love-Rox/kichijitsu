import type {
  BlockMode,
  BlockRuleDeleteRequest,
  BlockRuleDTO,
  BlockRuleUpsertRequest,
  CalendarListEntryDTO,
} from "@kichijitsu/shared";

/**
 * カレンダーブロック (docs/blocking.md、2026-07-20) の設定 UI 用ヘルパー。
 * visibleCalendars.ts と同じ流儀 — fetch や副作用は持たない純関数のみで、
 * リクエスト構築と、一覧表示用の DTO → 表示用データへの整形を担う。
 * 実際の POST/DELETE /api/block-rules 呼び出しは hooks/useBlockRules.ts (checkedFetch 経由) が行う
 * (2026-07-25 のフック分割まで App.tsx が持っていた)。
 */

/** POST /api/block-rules のリクエストボディを組み立てる。id 省略で新規作成、指定で更新 */
export function buildBlockRuleUpsertRequest(
  sources: { accountId: string; calendarId: string }[],
  target: { accountId: string; calendarId: string },
  mode: BlockMode,
  id?: string,
): BlockRuleUpsertRequest {
  return { id, sources, target, mode };
}

/**
 * DELETE /api/block-rules のリクエストボディを組み立てる。
 *
 * deleteMirrors は必須引数にしてある ―― サーバー側の既定は false (省略で来たら Google の
 * 予定は消さない、shared の BlockRuleDeleteRequest 参照) なので、UI からは常に
 * 「利用者がチェックボックスで選んだ値」を明示して送る。省略できると
 * 「チェックしたのに送られていない」取り違えが起きうるため。
 */
export function buildBlockRuleDeleteRequest(
  id: string,
  deleteMirrors: boolean,
): BlockRuleDeleteRequest {
  return { id, deleteMirrors };
}

/** mode の表示名 (バッジに使う) */
const MODE_LABELS: Record<BlockMode, string> = {
  busy: "予定あり",
  outOfOffice: "不在",
};

export function blockModeLabel(mode: BlockMode): string {
  return MODE_LABELS[mode];
}

/**
 * accountId・calendarId からカレンダー名を解決する。calendarsByAccount に該当エントリが
 * 無ければ(未取得・取得失敗・削除済み等)calendarId をそのままフォールバックとして返す
 * — UI 側が空表示にならないようにするため
 */
export function resolveCalendarName(
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>,
  accountId: string,
  calendarId: string,
): string {
  const calendar = calendarsByAccount[accountId]?.find((c) => c.id === calendarId);
  return calendar?.summary ?? calendarId;
}

/** BlockRuleDTO を一覧行の表示に必要な形へ整形したもの */
export interface BlockRuleDisplay {
  id: string;
  /** source カレンダー名の配列(複数はカンマ区切り表示を呼び出し側に委ねるため配列のまま渡す) */
  sourceNames: string[];
  targetName: string;
  modeLabel: string;
  /** true = 不在を要求したが Workspace 非対応で busy として作成された (一覧の注記表示用) */
  oooFallback: boolean;
}

/** ルール一覧表示用に DTO を整形する(カレンダー名解決込み) */
export function describeBlockRule(
  rule: BlockRuleDTO,
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>,
): BlockRuleDisplay {
  return {
    id: rule.id,
    sourceNames: rule.sources.map((s) =>
      resolveCalendarName(calendarsByAccount, s.accountId, s.calendarId),
    ),
    targetName: resolveCalendarName(
      calendarsByAccount,
      rule.target.accountId,
      rule.target.calendarId,
    ),
    modeLabel: blockModeLabel(rule.mode),
    oooFallback: rule.mode === "outOfOffice" && rule.oooFallback === true,
  };
}
