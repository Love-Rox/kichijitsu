/**
 * 同一キーの非同期処理の多重実行を防ぐ、汎用の直列化スケジューラ (2026-07-21)。
 *
 * App.tsx の syncCalendar は SSE hello/changed(useServerEvents)、起動時 runSync、
 * カレンダー選択トグルなど複数経路から await なしで多重に発火しうる。同一
 * (accountId, calendarId) の増分同期と全同期(410 フォールバック)が交錯すると
 * IndexedDB の削除→再投入が競合するため、キー単位で直列化するガードとして使う。
 *
 * 単純な「走行中なら何もしない」だと、走行中の同期が開始した時点より後に届いた
 * 変更(SSE changed 等)を取りこぼす。そのため「走行中に再要求が来たら、完了後に
 * もう1回だけ再実行する」(coalesce & trailing rerun) 方式にしている。同じキーへの
 * 再要求は何度来ても trailing rerun は1回に潰す(1回のトレーリング実行で
 * 全ての再要求ぶんの最新状態を拾える想定のため)。
 */

/** schedule() に渡す実処理。副作用を持ってよいが、キー単位で直列実行される前提 */
export type SyncRunner = () => Promise<void>;

export interface SyncScheduler {
  /**
   * key の処理を run で実行する。同じ key の処理が既に走行中なら、新規には開始せず
   * 走行中の Promise を返しつつ「完了後にもう1回だけ再実行する」フラグを立てる。
   * 返り値の Promise は、trailing rerun が発生した場合はそれも含めて完了するまで
   * 解決しない(合流した呼び出し元は全員、最終的な完了/失敗を観測できる)。
   */
  schedule(key: string, run: SyncRunner): Promise<void>;
}

export function createSyncScheduler(): SyncScheduler {
  const inFlight = new Map<string, Promise<void>>();
  const rerunRequested = new Set<string>();

  async function runLoop(key: string, run: SyncRunner): Promise<void> {
    let failed = false;
    let lastError: unknown;
    do {
      // このラウンドで拾う再要求は消費済みにする(ラウンド中に来た新規の再要求は
      // 次のループでまた rerunRequested に立つので取りこぼさない)
      rerunRequested.delete(key);
      try {
        await run();
        failed = false;
      } catch (err) {
        failed = true;
        lastError = err;
      }
    } while (rerunRequested.has(key));

    // エラーの有無に関わらずロックは必ず解放する(解放を忘れると以降そのキーの
    // schedule() が永久に「走行中」扱いになり、二度と実行されなくなる)
    inFlight.delete(key);
    if (failed) throw lastError;
  }

  function schedule(key: string, run: SyncRunner): Promise<void> {
    const existing = inFlight.get(key);
    if (existing) {
      rerunRequested.add(key);
      return existing;
    }
    const promise = runLoop(key, run);
    inFlight.set(key, promise);
    return promise;
  }

  return { schedule };
}
