/**
 * work_logs (作業実績、docs/mcp.md「エージェントの作業時間記録」) の**共有ロジック**。
 *
 * この package は 2026-07-25 まで型 (protocol.ts) だけを持っていて runtime export がゼロだった。
 * ここが最初の runtime モジュール — 置いてよいのは「web (React) でも sync (Workers) でも同じ答えを
 * 返さなければ困る純関数」だけに限る (DOM/D1/Temporal など環境依存の API は一切使わない。
 * バンドラ (vite / wrangler) が各アプリのビルドに src をそのまま取り込むため、ビルド構成の追加は
 * 不要だが、その代わり両アプリの tsconfig (strict / verbatimModuleSyntax / noUnusedLocals) を
 * 同時に満たす必要がある)。
 *
 * なぜ複製をやめたか (2026-07-25、リファクタリング フェーズ4):
 *  - formatDurationHm が apps/web/src/sync/timeTracking.ts と apps/sync/src/core/work-log.ts に
 *    バイト単位で同一の複製として存在していた (「sync は web に依存していないため複製」)。
 *  - より深刻だったのは集計の二重定義: web の実績履歴 (groupWorkLogsByIssue) は issueRef を
 *    「issue の所属 repo + 番号」へ正規化してからまとめる一方、sync の MCP work_summary
 *    (aggregateWorkLogs) は issue_ref の生文字列でまとめていたため、hook が完全参照
 *    (`owner/repo#12`) で記録した実績と UI タイマー由来の素の番号 (`12`) が**別グループに割れ**、
 *    同じデータを見ているのに web の実績履歴と MCP work_summary で数字が食い違っていた。
 *    バケットキーの正規化 (workLogIssueIdentity) と期間合計 (aggregateWorkLogEntries) をここに
 *    1つだけ置き、両者がこれを使う。
 *
 * 表示のための差 (「issue 無し」のラベル文字列・並び順) は各アプリ側に残す — 集計の定義は1つ、
 * 見せ方はそれぞれ、という切り分け (下の aggregateWorkLogEntries のコメント参照)。
 */

/** "2h 15m" / "45m" 形式。0分未満に丸まる端数は切り捨て、負の入力は 0 扱い。 */
export function formatDurationHm(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * グルーピングキーの区切り文字。repo 名にも issue 番号にも現れ得ない文字でないと
 * (repo="a", 番号="b:c") と (repo="a:b", 番号="c") のようなキー衝突が起きるため、文字列として
 * まず現れない NUL (U+0000) を使う。ソース上は生の 0x00 バイトではなく `\u0000` エスケープで
 * 書く: 生バイトを埋め込むと git がファイルをバイナリと判定して diff が読めなくなる。
 */
const KEY_SEP = "\u0000";

/** issue の同一性 (所属 repo + 番号)。issueRef が無い (issue 無し) なら hasIssue=false。 */
export interface WorkLogIssueIdentity {
  key: string;
  /** 表示・グループ化に使う repo (issue 付きは issue 所属 repo、無しは作業 repo)。 */
  repo: string;
  /** issue/PR 番号 (issue 付きのみ)。数値とは限らない (ブランチ名由来の参照もある)。 */
  issueRef?: string;
  hasIssue: boolean;
}

/**
 * 純関数。(作業 repo, issueRef) から issue の同一性を導く。
 * - issueRef 空/空白 → issue 無し (作業 repo でまとめる)。
 * - issueRef が `owner/repo#番号` (# の前に "/" を含む) → 所属 repo = # の前、番号 = # の後。
 * - issueRef が `#番号` / 素の `番号` → 所属 repo = 作業 repo、番号 = # の後 (無ければ全体)。
 * これにより「同じ issue を別 repo の作業として記録」しても同一キーになる。
 *
 * **issueRef 正規化の唯一の置き場**: web 側は実績履歴のグループ化 (sync/workLogGrouping.ts)・
 * 開区間の走行判定/メタ補完 (sync/openIntervals.ts)・hook 実績の突合 (sync/hookActual.ts) が、
 * server 側は MCP work_summary の集計 (core/work-log.ts の aggregateWorkLogs) がここを通る。
 * 以前は web の3系統だけがここに寄っていて server は生の issue_ref でまとめていたため、
 * 同じ issue の実績が web と MCP で別の数字になっていた (2026-07-25 に shared へ移設)。
 */
export function workLogIssueIdentity(
  repo: string,
  issueRef: string | undefined,
): WorkLogIssueIdentity {
  const ref = issueRef?.trim();
  if (!ref) {
    return { key: `repo${KEY_SEP}${repo}`, repo, hasIssue: false };
  }
  const hash = ref.lastIndexOf("#");
  let issueRepo = repo;
  let number = ref;
  if (hash >= 0) {
    const left = ref.slice(0, hash).trim();
    number = ref.slice(hash + 1).trim();
    if (left.includes("/")) issueRepo = left; // "owner/repo#番号" の完全参照
    // "#番号" は所属 repo が無いので作業 repo のまま
  }
  return {
    key: `issue${KEY_SEP}${issueRepo}${KEY_SEP}${number}`,
    repo: issueRepo,
    issueRef: number,
    hasIssue: true,
  };
}

/**
 * 集計の入力に必要な最小構造。web の WorkLogDTO も server の work_logs 行 (snake_case からの
 * 詰め替え) も構造的にこれを満たす。
 */
export interface WorkLogAggregateEntry {
  repo: string;
  issueRef?: string;
  startMs: number;
  endMs: number;
}

/** aggregateWorkLogEntries の結果1件 (issue の同一性ごとのバケット)。 */
export interface WorkLogAggregateBucket<T extends WorkLogAggregateEntry> {
  /** workLogIssueIdentity.key。 */
  key: string;
  /** issue 付きは issue の所属 repo、issue 無しは作業 repo。 */
  repo: string;
  /** issue/PR 番号。issue 無しバケットでは undefined (ラベル文字列は呼び出し側が決める)。 */
  issueRef?: string;
  /** 区間長 (endMs - startMs) の合計。endMs <= startMs の記録は加算しない。 */
  totalMs: number;
  /** totalMs に寄与した (endMs > startMs の) 記録数。 */
  count: number;
  /** バケットに属する**全**記録 (endMs <= startMs の異常な記録も含む、入力順)。 */
  entries: T[];
  /** バケット内の最大 startMs (「最近やった順」の並びキー)。 */
  latestStartMs: number;
}

/**
 * 純関数。work_logs の記録群を issue の同一性 (workLogIssueIdentity) でバケットに分け、区間長の
 * 合計を出す。**集計の定義はここ1つだけ** — web の実績履歴 (groupWorkLogsByIssue) と MCP の
 * work_summary (aggregateWorkLogs) が同じ数字を出すための土台。
 *
 * - endMs <= startMs の異常な記録は totalMs にも count にも含めない (「実績が無い区間」を
 *   「実績あり・0分」として件数に混ぜると平均時間などをミスリードするため)。ただし entries には
 *   残す — web の実績履歴は一覧に出して利用者が訂正/削除できる必要があり、集計から外すことと
 *   一覧から消すことは別だから (通常この行は validateWorkLogInterval が入口で弾くので現れない。
 *   PATCH で start だけを更新して区間が反転した場合の防御)。
 * - 並び替えはしない (入力の初出順)。「totalMs 降順」(MCP) と「最近やった順」(web 実績履歴) の
 *   どちらが要るかは表示側の都合なので、呼び出し側で sort する。
 */
export function aggregateWorkLogEntries<T extends WorkLogAggregateEntry>(
  entries: readonly T[],
): WorkLogAggregateBucket<T>[] {
  const buckets = new Map<string, WorkLogAggregateBucket<T>>();

  for (const entry of entries) {
    const identity = workLogIssueIdentity(entry.repo, entry.issueRef);
    let bucket = buckets.get(identity.key);
    if (!bucket) {
      bucket = {
        key: identity.key,
        repo: identity.repo,
        issueRef: identity.issueRef,
        totalMs: 0,
        count: 0,
        entries: [],
        latestStartMs: entry.startMs,
      };
      buckets.set(identity.key, bucket);
    }
    bucket.entries.push(entry);
    if (entry.endMs > entry.startMs) {
      bucket.totalMs += entry.endMs - entry.startMs;
      bucket.count += 1;
    }
    if (entry.startMs > bucket.latestStartMs) bucket.latestStartMs = entry.startMs;
  }

  return [...buckets.values()];
}

/**
 * work_logs 入力の検証エラー。web の手動追加フォーム (sync/workLogEntry.ts) と server の
 * POST /api/work-logs・POST /api/work-intervals・MCP log_work_interval で同じ enum を使う
 * (以前は同じ4値が web/server で二重定義されていた)。
 */
export type WorkLogValidationError =
  | "missing_repo"
  | "invalid_start"
  | "invalid_end"
  | "start_not_before_end";

/**
 * 純関数。repo 必須・start/end がパースできている・start<end を検証する。**判定の順序**も
 * 契約の一部 (repo → start → end → 前後関係) — server は 400 のエラーコード、web はフォームの
 * エラー文言としてこの値をそのまま使うため、寄せた後も同じコードが返る必要がある。
 *
 * 文字列 → epoch ms の変換は呼び出し側で行う (server は Date.parse、web は datetime-local の値を
 * アプリ設定のタイムゾーンのローカル壁時計として Temporal で解釈する)。パースできなかったことは
 * null または NaN で表す — どちらでも invalid_start / invalid_end になる。
 */
export function validateWorkLogInterval(input: {
  repo: string;
  startMs: number | null;
  endMs: number | null;
}): WorkLogValidationError | null {
  if (!input.repo || input.repo.trim().length === 0) return "missing_repo";
  if (input.startMs === null || Number.isNaN(input.startMs)) return "invalid_start";
  if (input.endMs === null || Number.isNaN(input.endMs)) return "invalid_end";
  if (input.startMs >= input.endMs) return "start_not_before_end";
  return null;
}
