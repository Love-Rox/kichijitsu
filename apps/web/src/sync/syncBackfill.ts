/**
 * 同期バックフィル対象の判定 (2026-07-22、旧 oooBackfill.ts の一般化)。
 *
 * 元々は eventType バックフィル (不在レール表示 a00fa80 導入前に同期済みだったイベントに
 * isOutOfOffice を行き渡らせる、一度きりの forceFull 同期) 専用のモジュールだった。RSVP 表示
 * (selfResponseStatus/isOrganizer/hasConference) の追加で「クライアント側だけで新フィールドを
 * 増やすたびに、過去に同期済みのイベントへ行き渡らせる必要がある」という同じ課題が再発したため、
 * boolean の「実施済みか」判定を世代番号の比較に一般化した(db/database.ts の
 * CURRENT_SYNC_BACKFILL_VERSION/getSyncBackfillVersion 参照)。
 *
 * ここでは「どのカレンダーを対象にすべきか」の判定だけを純関数として切り出す
 * (hooks/useCalendarSync.ts の runSyncBackfillIfNeeded が抱える副作用 — IndexedDB
 * 読み書き・fetch — から独立してテストするため)。
 */

export interface SyncBackfillTarget {
  accountId: string;
  calendarId: string;
}

/**
 * 実際にバックフィル完了として記録してよい世代 = min(このクライアントの世代, サーバー対応世代)。
 *
 * web と sync は別々にデプロイされるため、web だけ先に新しくなると「サーバーがまだそのフィールドを
 * 返さないのに、クライアントは forceFull 同期をやり切って世代を記録してしまう」ことが起きる。
 * すると以後バックフィルは走らず、新フィールドが永久に欠けたままになる (世代3で実際に起きた事故。
 * 当時は世代4を空振り用に消費して手当てした)。その恒久対策として GET /api/me が
 * MeResponse.syncBackfillVersion で「sync が対応している世代」を宣言するようになったので、
 * クライアントはそこまでしか記録しない — サーバーが後から追いついた時点で、残りの世代ぶんの
 * バックフィルが次の起動時に自然に走る。
 *
 * serverVersion が undefined (この仕組みより前の sync がデプロイされている / まだ /api/me を
 * 取得していない) の場合は従来どおりクライアントの世代をそのまま使う。負や NaN のような
 * 異常値は「宣言が無い」と同じ扱いにする (Math.min で 0 を掴んで毎起動 forceFull し続けるのを防ぐ)。
 */
export function resolveEffectiveSyncBackfillVersion(
  clientVersion: number,
  serverVersion: number | undefined,
): number {
  if (typeof serverVersion !== "number" || !Number.isFinite(serverVersion) || serverVersion < 1) {
    return clientVersion;
  }
  return Math.min(clientVersion, serverVersion);
}

/**
 * バックフィル対象の列挙。
 * - savedVersion が currentVersion 以上 (=既に追いついている) なら空配列 (再実行しない)
 * - 未達なら、現在選択中の全 (accountId, calendarId) をそのまま返す
 *
 * 世代が複数離れていても(例: 旧 boolean 移行直後の 1 → 現行 2 など)対象は常に選択中の
 * 全カレンダーのまま ―― 1回の forceFull 同期で最新の DTO 全フィールドが一気に届くため、
 * 世代ごとに個別のバックフィルを重ねて走らせる必要はない(常に「保存済み世代 → 現行世代」への
 * 1ジャンプとして扱う)。
 *
 * T を selectedTargets() の要素型 (WriteTargetCandidate、defaultColor/primary 等の
 * 付加情報を持つ) にも対応できるよう accountId/calendarId を持つ最小構造で受け取る
 * ジェネリクスにしてある — 呼び出し側 (hooks/useCalendarSync.ts の runSyncBackfillIfNeeded) は
 * 同期に必要な defaultColor 等を保ったまま渡せる。
 */
export function decideSyncBackfillTargets<T extends SyncBackfillTarget>(
  savedVersion: number,
  currentVersion: number,
  selectedTargets: readonly T[],
): readonly T[] {
  if (savedVersion >= currentVersion) return [];
  return selectedTargets;
}

/** excludeReauthPendingTargets の返り値。 */
export interface BackfillTargetPlan<T extends SyncBackfillTarget> {
  /** 実際に forceFull 同期すべき対象(reauth 待ちアカウント分は除外済み)。 */
  targets: readonly T[];
  /**
   * true なら reauth 待ちアカウントの分を除外した(= decideSyncBackfillTargets が返した
   * 全選択中カレンダーではない)ことを表す。呼び出し側 (hooks/useCalendarSync.ts の
   * runSyncBackfillIfNeeded) はこれが true のとき、除外後の残りが全部成功しても
   * バックフィル版数を記録してはいけない。
   */
  excludedReauthPending: boolean;
}

/**
 * バックフィル対象から「再認証待ち (reauthRequired) なアカウント」を除外する
 * (2026-08-07、本番実測を受けたレビュー指摘への対応)。
 *
 * # なぜ必要か
 * このファイル冒頭の resolveEffectiveSyncBackfillVersion のコメントが警戒しているのと
 * **同じ種類の「永久に欠ける」事故**を、reauth 待ちアカウントに対しても起こしてしまうため:
 * 除外せずに forceFull を試みると sync/reauthSkip.ts の shouldSkipAutoSyncForReauth が
 * その (accountId, calendarId) の同期を黙ってスキップする。スキップは Promise.allSettled から
 * 見ると "fulfilled" (例外を投げない) なので、他の対象が全て成功していれば
 * runSyncBackfillIfNeeded は「全成功」と誤認し、その世代を記録してしまう。すると
 * 記録後は同じ世代の forceFull が二度と走らないため、そのアカウントが後で再認証されても
 * この世代ぶんのバックフィル(新フィールドの取りこぼし解消)を**永久に受けられない**。
 *
 * # 対処
 * 同期を試みる前に対象から reauth 待ちアカウント分を除外し、除外が発生したかどうかを
 * `excludedReauthPending` として呼び出し側に返す。呼び出し側はこれが true の間は
 * (残りが全部成功しても) 版数を記録しない ―― 結果として、そのアカウントが reauth 待ちの
 * 間は毎起動バックフィルが再試行される(他アカウント分の forceFull を含めて繰り返す)。
 * これは resolveEffectiveSyncBackfillVersion のコメントが既に受け入れている
 * 「サーバーが追いついたら次回起動で残りが走る」という性質と同じで、この再試行コストより
 * 「一生欠けたまま」の方が悪いという判断を踏襲している。
 *
 * reauthRequiredAccountIds が空 (=誰も reauth 待ちでない) なら selectedTargets をそのまま
 * 返す(decideSyncBackfillTargets と同じく、変化が無ければ同じ参照を返す配慮)。
 */
export function excludeReauthPendingTargets<T extends SyncBackfillTarget>(
  selectedTargets: readonly T[],
  reauthRequiredAccountIds: ReadonlySet<string>,
): BackfillTargetPlan<T> {
  if (reauthRequiredAccountIds.size === 0) {
    return { targets: selectedTargets, excludedReauthPending: false };
  }
  const targets = selectedTargets.filter((t) => !reauthRequiredAccountIds.has(t.accountId));
  return { targets, excludedReauthPending: targets.length !== selectedTargets.length };
}
