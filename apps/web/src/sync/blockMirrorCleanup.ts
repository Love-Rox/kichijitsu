/**
 * 「コピー先カレンダーに残ったブロック予定 (孤児ミラー) を掃除する」UI 用のヘルパー
 * (docs/blocking.md「ミラー予定の後始末」節、末尾「将来やるならこれ」2026-07-28 追記分)。
 *
 * blockRules.ts / mcpTokens.ts と同じ流儀 ―― fetch や副作用は持たない純関数のみで、
 * 一覧の整形・並び替え・グルーピングと、削除確定後の反映計算を担う。実際の
 * GET /api/block-mirrors/orphans・POST /api/block-mirrors/cleanup 呼び出しは
 * hooks/useBlockMirrorCleanup.ts (checkedFetch 経由) が行う。
 *
 * ## 通信用の DTO は @kichijitsu/shared が正本
 * `OrphanMirrorDTO` / `BlockMirrorScanEntry` / `BlockMirrorCleanupItem` / `*Request` / `*Response`
 * は apps/sync (サーバー) と共有の型として packages/shared/src/protocol.ts に定義されている
 * (BlockRuleDTO 等、他のカレンダーブロック関連 DTO と同じ置き場)。このファイルはそれらを
 * import して使うだけで、通信の形を独自に定義し直さない。
 *
 * このファイルが自前で持つのは**画面表示のためだけに組み立てる UI 層の型**
 * (BlockMirrorCalendarGroup / BlockMirrorCleanupConfirmSummary / BlockMirrorFailedDetail /
 * BlockMirrorCleanupApplyResult) だけ ―― これらはサーバーとやり取りする形ではなく、
 * このファイルの純関数が入力を加工して作る出力なので、shared には置かない。
 */
import type {
  BlockMirrorCleanupItem,
  BlockMirrorCleanupRequest,
  BlockMirrorCleanupResponse,
  BlockMirrorEventTime,
  BlockMirrorScanEntry,
  OrphanMirrorDTO,
} from "@kichijitsu/shared";

/**
 * orphan 1件の calendarSummary を確定させる。**OrphanMirrorDTO は calendarSummary を持たない**
 * (走査したカレンダー名は BlockMirrorScanEntry 側に1カレンダーにつき1回だけ載る設計 ――
 * protocol.ts の OrphanMirrorDTO のコメント参照) ので、scanned から同じ (accountId, calendarId)
 * を持つエントリを引く。
 *
 * 見つからない場合の最終フォールバックは calendarId そのもの (sync/blockRules.ts の
 * resolveCalendarName と同じ「id をそのまま出す」流儀)。実際には**通常ここには到達しない** ――
 * 孤児が1件でも見つかった時点で、その孤児が属するカレンダーの走査自体は成功している
 * (ok: true で scanned に積まれている、routes/block-mirrors.ts 参照) ため。
 */
export function resolveOrphanCalendarSummary(
  orphan: OrphanMirrorDTO,
  scanned: readonly BlockMirrorScanEntry[],
): string {
  const scan = scanned.find(
    (s) => s.accountId === orphan.accountId && s.calendarId === orphan.calendarId,
  );
  return scan?.calendarSummary ?? orphan.calendarId;
}

/**
 * 一覧の選択状態・削除リクエストの照合に使う複合キー。eventId は calendar スコープなので、
 * accountId・calendarId まで含めないと別カレンダーでの偶然の一致を誤って同一視しうる
 * (layout/keys.ts の calendarKey と同じ理由でここも複合キーにしてある)。
 */
export function orphanKey(item: BlockMirrorCleanupItem): string {
  return `${item.accountId}:${item.calendarId}:${item.eventId}`;
}

/**
 * 開始/終了 ({dateTime?, date?}) をソート用の比較可能な epoch ms へ変換する。
 * 契約上どちらか一方が必ず入っている前提 (Google Calendar の終日/時刻予定の二択)。
 * どちらも無い異常系は 0 に落として先頭に固定するだけにする(実害が無い最も安全な扱い)。
 */
export function orphanStartMs(point: BlockMirrorEventTime): number {
  const raw = point.dateTime ?? point.date;
  return raw ? new Date(raw).getTime() : 0;
}

/** 日時昇順に並べ替える(新しい配列を返す。引数は変更しない) */
export function sortOrphansByStart(orphans: readonly OrphanMirrorDTO[]): OrphanMirrorDTO[] {
  return [...orphans].sort((a, b) => orphanStartMs(a.start) - orphanStartMs(b.start));
}

/** UI 表示用: カレンダーごとにまとめた孤児一覧の1グループ (通信の形ではなく画面表示のための集計)。 */
export interface BlockMirrorCalendarGroup {
  key: string;
  accountId: string;
  calendarId: string;
  calendarSummary: string;
  orphans: OrphanMirrorDTO[];
}

/**
 * カレンダーごとにまとめ、各グループ内は日時昇順にする。グループ自体の並びはカレンダー名の
 * 辞書順 (ja) ―― 走査結果の到着順のような不安定な基準に表示順を委ねないための措置。
 * 同名カレンダーが複数アカウントにある場合は key (accountId:calendarId) で tie-break する。
 */
export function groupOrphansByCalendar(
  orphans: readonly OrphanMirrorDTO[],
  scanned: readonly BlockMirrorScanEntry[],
): BlockMirrorCalendarGroup[] {
  const groups = new Map<string, BlockMirrorCalendarGroup>();
  for (const orphan of orphans) {
    const key = `${orphan.accountId}:${orphan.calendarId}`;
    const group = groups.get(key);
    if (group) {
      group.orphans.push(orphan);
    } else {
      groups.set(key, {
        key,
        accountId: orphan.accountId,
        calendarId: orphan.calendarId,
        calendarSummary: resolveOrphanCalendarSummary(orphan, scanned),
        orphans: [orphan],
      });
    }
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.orphans = sortOrphansByStart(group.orphans);
  }
  result.sort(
    (a, b) => a.calendarSummary.localeCompare(b.calendarSummary, "ja") || a.key.localeCompare(b.key),
  );
  return result;
}

/**
 * scanned のうち走査に失敗したカレンダー (ok === false) だけを抜き出す。
 * 「0件」表示と「調べられなかった」を混同させないための専用ヘルパー
 * (呼び出し側 = BlockMirrorCleanupOverlay は、orphans が0件でもこれが1件でもあれば
 * 「見つかりませんでした」ではなく警告バナーを出す)。
 */
export function scanFailures(scanned: readonly BlockMirrorScanEntry[]): BlockMirrorScanEntry[] {
  return scanned.filter((s) => !s.ok);
}

/** 選択済みキー集合から対応する orphans を解決する(チェックボックス選択 → 削除対象 DTO) */
export function resolveSelectedOrphans(
  orphans: readonly OrphanMirrorDTO[],
  selectedKeys: ReadonlySet<string>,
): OrphanMirrorDTO[] {
  return orphans.filter((o) => selectedKeys.has(orphanKey(o)));
}

/** POST /api/block-mirrors/cleanup のリクエストボディを組み立てる */
export function buildCleanupRequest(
  selected: readonly OrphanMirrorDTO[],
): BlockMirrorCleanupRequest {
  return {
    items: selected.map((o) => ({
      accountId: o.accountId,
      calendarId: o.calendarId,
      eventId: o.eventId,
    })),
  };
}

/** UI 表示用: 削除確認ダイアログの文言の材料 (通信の形ではなく画面表示のための集計)。 */
export interface BlockMirrorCleanupConfirmSummary {
  count: number;
  /** 対象カレンダー名の一意な一覧(名前順)。確認文に「どのカレンダーから消すか」を出すための材料 */
  calendarSummaries: string[];
}

/**
 * 確認ダイアログの文言の材料(件数と対象カレンダー名)を作る。
 * 「何件を、どのカレンダーから消すのかが確認文に出ること」という要件をここで固定する
 * ―― UI 側の文言をどう書いても、この2つの値さえ描けば要件を満たせるようにする。
 */
export function describeCleanupTargets(
  selected: readonly OrphanMirrorDTO[],
  scanned: readonly BlockMirrorScanEntry[],
): BlockMirrorCleanupConfirmSummary {
  const calendarSummaries = [
    ...new Set(selected.map((o) => resolveOrphanCalendarSummary(o, scanned))),
  ].sort((a, b) => a.localeCompare(b, "ja"));
  return { count: selected.length, calendarSummaries };
}

/** UI 表示用: 削除できなかった1件の表示用詳細 (通信の形ではなく画面表示のための集計)。 */
export interface BlockMirrorFailedDetail {
  eventId: string;
  reason: string;
  calendarSummary: string;
}

/** UI 表示用: cleanup 応答を一覧へ反映した結果 (通信の形ではなく画面表示のための集計)。 */
export interface BlockMirrorCleanupApplyResult {
  remaining: OrphanMirrorDTO[];
  failedDetails: BlockMirrorFailedDetail[];
}

/**
 * cleanup 応答を一覧へ反映する。成功分 (failed に載らなかった要求分) を orphans から除き、
 * failed はカレンダー名を添えて返す。
 *
 * サーバーは deleted の件数と failed (eventId + reason) しか返さない ―― 「成功した eventId」
 * 自体は返ってこないので、「要求したのに failed に居ない = 成功した」という消去法で求める。
 * failed の calendarSummary は応答に含まれないため、削除前の orphans (prevOrphans) から引いた
 * 上で resolveOrphanCalendarSummary により scanned から解決する。
 *
 * 既知の限界: failed は eventId だけで (accountId/calendarId を持たない) 識別されるため、
 * 同じ eventId が偶然複数カレンダーにまたがって要求された場合は区別できない
 * (Google の event id はカレンダー内一意なので通常は起きない)。
 */
export function applyCleanupResult(
  prevOrphans: readonly OrphanMirrorDTO[],
  requestedItems: readonly BlockMirrorCleanupItem[],
  response: BlockMirrorCleanupResponse,
  scanned: readonly BlockMirrorScanEntry[],
): BlockMirrorCleanupApplyResult {
  const failedIds = new Set(response.failed.map((f) => f.eventId));
  const succeededKeys = new Set(
    requestedItems.filter((item) => !failedIds.has(item.eventId)).map((item) => orphanKey(item)),
  );
  const remaining = prevOrphans.filter((o) => !succeededKeys.has(orphanKey(o)));
  const failedDetails = response.failed.map((f) => {
    const match = prevOrphans.find((o) => o.eventId === f.eventId);
    return {
      eventId: f.eventId,
      reason: f.reason,
      calendarSummary: match ? resolveOrphanCalendarSummary(match, scanned) : "(カレンダー不明)",
    };
  });
  return { remaining, failedDetails };
}

/**
 * 一覧行の日時表示。終日/時刻の両方に対応する。ブラウザロケール表示にしているのは
 * mcpTokens.ts の mcpTokenCreatedLabel と同じ理由 ―― ここはアプリ通常表示(timeZone 設定に
 * 従うグリッド)ではなく、由来の分からない孤児を見つけて消すための管理画面なので、
 * 厳密な timeZone 一致より「読んで判断できる」ことを優先した。
 */
export function formatOrphanRange(orphan: Pick<OrphanMirrorDTO, "start" | "end">): string {
  if (orphan.start.date) {
    return formatAllDayRange(orphan.start.date, orphan.end.date ?? orphan.start.date);
  }
  if (!orphan.start.dateTime) return "(日時不明)";
  const start = new Date(orphan.start.dateTime);
  const startLabel = `${start.toLocaleDateString("ja-JP")} ${formatTimeOfDay(start)}`;
  if (!orphan.end.dateTime) return startLabel;
  const end = new Date(orphan.end.dateTime);
  const sameDay = start.toDateString() === end.toDateString();
  const endLabel = sameDay ? formatTimeOfDay(end) : `${end.toLocaleDateString("ja-JP")} ${formatTimeOfDay(end)}`;
  return `${startLabel}–${endLabel}`;
}

function formatTimeOfDay(d: Date): string {
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** Google の終日予定は end.date が「翌日 (exclusive)」。表示は最終日(endDateExclusive の前日)を使う */
function formatAllDayRange(startDate: string, endDateExclusive: string): string {
  const start = new Date(`${startDate}T00:00:00`);
  const lastDay = new Date(`${endDateExclusive}T00:00:00`);
  lastDay.setDate(lastDay.getDate() - 1);
  const startLabel = start.toLocaleDateString("ja-JP");
  if (lastDay.getTime() <= start.getTime()) {
    return `${startLabel}（終日）`;
  }
  return `${startLabel} 〜 ${lastDay.toLocaleDateString("ja-JP")}（終日）`;
}
