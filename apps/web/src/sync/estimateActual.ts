/**
 * commit からの実績自動推定 (docs/github-integration.md「時間計測」増分3 Part B、2026-07-20)。
 * POST /api/github/pr-commits (Part A) が返す「PR ごとの自分の commit の ISO タイムスタンプ
 * 昇順配列」を、セッション単位にクラスタリングして所要時間を見積もる純関数群。DOM/store には
 * 一切触れない (App.tsx がフェッチと配線を、TimeReportOverlay.tsx が表示を担当する)。
 *
 * 手動タイマー実績 (sync/timeTracking.ts の TimeEntry ベース) とは完全に別立てのデータであり、
 * ここで計算した推定値を実績 (actualMs) に混ぜ込むことはしない — レポート側で「推定」列として
 * 区別して併記する。issue には commit が無い (対象外) ため、この層は PR のみを扱う前提。
 *
 * アルゴリズム (既定値は下の DEFAULT_* 定数、呼び出し側で調整可能):
 * 1. clusterCommitSessions: commit 時刻を昇順ソートし、隣接する2つの commit の間隔が
 *    gapMs を「超えたら」(> gapMs、ちょうど gapMs は同一セッション) 別セッションに分割する。
 * 2. estimateSessionMs: 各セッションの所要時間を (最後の commit - 最初の commit) + leadInMs
 *    と見積もる (commit する前の作業時間を leadIn として加算する。単一 commit のセッションは
 *    差分が 0 なので leadInMs のみ)。capMs で1セッションあたりの上限をクランプする
 *    (バルク import や過去分をまとめて commit したケースの暴走防止)。
 * 3. estimateActualMs: 全セッションの見積もりを合計する。
 */

/** セッション分割の間隔しきい値(既定90分)。隣接 commit の間隔がこれを超えたら別セッション */
export const DEFAULT_GAP_MS = 90 * 60_000;

/** セッションのリードイン(既定30分)。commit 前の作業時間の見積もり分として毎セッションに加算 */
export const DEFAULT_LEAD_IN_MS = 30 * 60_000;

/** 1セッションあたりの上限(既定8時間)。これを超える見積もりはここでクランプする */
export const DEFAULT_CAP_MS = 8 * 3600_000;

export interface EstimateActualOptions {
  gapMs?: number;
  leadInMs?: number;
  capMs?: number;
}

/**
 * commit 時刻 (epoch ms) の配列を昇順ソートしてセッション単位にクラスタリングする。
 * 隣接する commit の間隔が gapMs を「超えたら」別セッションに分割する
 * (間隔がちょうど gapMs は同一セッションのまま)。空配列なら空配列を返す。
 */
export function clusterCommitSessions(timestampsMs: number[], gapMs: number): number[][] {
  if (timestampsMs.length === 0) return [];
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const sessions: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr - prev > gapMs) {
      sessions.push([curr]);
    } else {
      sessions[sessions.length - 1].push(curr);
    }
  }
  return sessions;
}

/**
 * 1セッション(昇順である必要は無い、内部で min/max を取る)の所要時間を見積もる。
 * (最後 - 最初) + leadInMs を capMs で上限クランプする。単一 commit のセッションは
 * 差分が0なので leadInMs のみになる。空配列は0を返す(通常は起こらない想定)。
 */
export function estimateSessionMs(
  session: number[],
  opts: { leadInMs: number; capMs: number },
): number {
  if (session.length === 0) return 0;
  const first = Math.min(...session);
  const last = Math.max(...session);
  const raw = last - first + opts.leadInMs;
  return Math.min(raw, opts.capMs);
}

/**
 * commit 時刻の配列(epoch ms、順不同可)からセッションにクラスタリングし、各セッションの
 * 見積もりを合計する。既定値は DEFAULT_GAP_MS / DEFAULT_LEAD_IN_MS / DEFAULT_CAP_MS。
 */
export function estimateActualMs(timestampsMs: number[], opts: EstimateActualOptions = {}): number {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const leadInMs = opts.leadInMs ?? DEFAULT_LEAD_IN_MS;
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const sessions = clusterCommitSessions(timestampsMs, gapMs);
  return sessions.reduce(
    (sum, session) => sum + estimateSessionMs(session, { leadInMs, capMs }),
    0,
  );
}

/**
 * POST /api/github/pr-commits のレスポンス (commitsByItem: キー "{owner/repo}#{number}" →
 * 昇順 ISO タイムスタンプ配列) を、キーごとの推定実績時間(ms)に変換する。ISO 文字列を
 * epoch ms に変換してから estimateActualMs に渡すだけ。不正な ISO (NaN になる) は
 * 無視する(サーバーは自身が発行した ISO しか返さない想定だが、念のための防御)。
 */
export function estimateByItemKey(
  commitsByItem: Record<string, string[]>,
  opts: EstimateActualOptions = {},
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, isoTimestamps] of Object.entries(commitsByItem)) {
    const timestampsMs = isoTimestamps
      .map((iso) => new Date(iso).getTime())
      .filter((ms) => !Number.isNaN(ms));
    result[key] = estimateActualMs(timestampsMs, opts);
  }
  return result;
}

/** レポート行(またはリクエスト対象)のキーを組み立てる。サーバーの commitsByItem のキー形式と一致させる */
export function reportItemKey(item: { repo: string; number: number }): string {
  return `${item.repo}#${item.number}`;
}

/**
 * 予定ブロック・手動タイマー実績から、レポートに出てくる PR (itemType==='pr') の
 * {repo, number} を重複無しで集める。POST /api/github/pr-commits に渡す items の組み立てに使う。
 * issue は commit と紐づかないため対象外(呼び出し側でフィルタし直す必要が無いようここで弾く)。
 */
export function collectPrTargets(
  plannedBlocks: { itemType: "issue" | "pr"; repo: string; number: number }[],
  timeEntries: { itemType: "issue" | "pr"; repo: string; number: number }[],
): { repo: string; number: number }[] {
  const seen = new Map<string, { repo: string; number: number }>();
  for (const item of [...plannedBlocks, ...timeEntries]) {
    if (item.itemType !== "pr") continue;
    const key = reportItemKey(item);
    if (!seen.has(key)) seen.set(key, { repo: item.repo, number: item.number });
  }
  return [...seen.values()];
}
