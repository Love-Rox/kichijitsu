import type { VisibleCalendarsRequest } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";

/**
 * カレンダー選択のサーバー同期 (2026-07-20)。GET /api/me が返す visibleCalendars
 * (configured なアカウントのみキーが在る) と、ローカルの選択状態 (state 兼 IndexedDB
 * キャッシュ) をマージする純関数、および PUT /api/visible-calendars のリクエスト構築。
 * App.tsx から呼ぶ (副作用・fetch は持たない)。
 *
 * 2026-07-21: PUT 失敗時の pending 追跡・再送を見込んだマージ (nextPendingVisiblePuts /
 * mergeServerVisibleCalendarsWithPending) を追加。lost update 防止の詳細は各関数の
 * コメント参照。
 */

/**
 * サーバーとローカルの選択状態をマージする。サーバーは正 (source of truth) —
 * サーバーに configured なエントリ (キーが存在する。空配列も含む) は常にサーバー側の
 * 値を採用する。サーバーに無いアカウント (未設定 = キー自体が無い) は、
 * ローカルの値をそのまま残す。これにより:
 * - IndexedDB キャッシュ (オフライン起動時) が、まだサーバーに反映されていない
 *   ローカルの選択 (初回 primary デフォルト選択の PUT が完了する前など) を保つ
 * - サーバーが「未設定」と答えたアカウントは、呼び出し側 (fetchCalendarsFor) が
 *   カレンダー一覧取得後に primary をデフォルト選択する余地を残す
 *
 * 呼び出し順序に依存しない (`{ ...local, ...server }` と等価) ので、
 * checkMe (/api/me 応答) と IndexedDB 初回ロードのどちらが先に解決しても安全に使える。
 */
export function mergeServerVisibleCalendars(
  local: VisibleCalendarsMap,
  server: Record<string, string[]>,
): VisibleCalendarsMap {
  return { ...local, ...server };
}

/** PUT /api/visible-calendars のリクエストボディを組み立てる */
export function buildVisibleCalendarsRequest(
  accountId: string,
  calendarIds: string[],
): VisibleCalendarsRequest {
  return { accountId, calendarIds };
}

/**
 * PUT /api/visible-calendars の lost update 防止 (2026-07-21)。
 *
 * オフライン中やサーバー側の一時障害で PUT が失敗すると、その accountId の
 * ローカルの選択がサーバーに反映されないまま残る。この状態で online 復帰時の
 * checkMe が /api/me を取得して mergeServerVisibleCalendars (サーバー勝ち) で
 * state を上書きすると、ついさっきローカルで変えた選択がサーバーの古い値に
 * 潰されてしまう(lost update)。
 *
 * 対策として App.tsx 側は失敗した (accountId, calendarIds) を pending map に
 * 記録し、checkMe の先頭で /api/me を取得する前に再送する。この2関数は
 * その pending map の更新とマージ結果への反映を担う純粋な部分:
 * - nextPendingVisiblePuts: PUT の成否に応じて pending map の次の状態を返す
 * - mergeServerVisibleCalendarsWithPending: 再送してもなお失敗が残る accountId は
 *   サーバー値でなくローカル値 (prev) を保つよう、サーバー勝ちマージの結果を補正する
 */
export type PendingVisiblePuts = ReadonlyMap<string, string[]>;

/**
 * PUT の成否に応じた pending map の次の状態を返す(元の map は変更しない)。
 * 成功したら該当 accountId のエントリを消し、失敗したら最新の calendarIds で
 * 上書き記録する(同じ accountId に対する再送前の複数回の失敗は、最新の
 * calendarIds だけが残ればよい)。
 */
export function nextPendingVisiblePuts(
  pending: PendingVisiblePuts,
  accountId: string,
  calendarIds: string[],
  outcome: "success" | "failure",
): Map<string, string[]> {
  const next = new Map(pending);
  if (outcome === "success") {
    next.delete(accountId);
  } else {
    next.set(accountId, calendarIds);
  }
  return next;
}

/**
 * checkMe が /api/me 応答をマージする際に使う、pending を考慮したマージ。
 * まず mergeServerVisibleCalendars (サーバー勝ち) を適用し、その後
 * stillPendingAccountIds (再送してもなお失敗が残っている accountId) に含まれる
 * エントリだけ prev (ローカルの直近値) で復元する。
 */
export function mergeServerVisibleCalendarsWithPending(
  prev: VisibleCalendarsMap,
  server: Record<string, string[]>,
  stillPendingAccountIds: Iterable<string>,
): VisibleCalendarsMap {
  const merged = mergeServerVisibleCalendars(prev, server);
  for (const accountId of stillPendingAccountIds) {
    if (accountId in prev) {
      merged[accountId] = prev[accountId];
    }
  }
  return merged;
}
