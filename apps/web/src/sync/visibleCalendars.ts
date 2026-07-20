import type { VisibleCalendarsRequest } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";

/**
 * カレンダー選択のサーバー同期 (2026-07-20)。GET /api/me が返す visibleCalendars
 * (configured なアカウントのみキーが在る) と、ローカルの選択状態 (state 兼 IndexedDB
 * キャッシュ) をマージする純関数、および PUT /api/visible-calendars のリクエスト構築。
 * App.tsx から呼ぶ (副作用・fetch は持たない)。
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
