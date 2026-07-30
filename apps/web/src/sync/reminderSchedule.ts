/**
 * 予定のリマインダー通知の「判定」だけを担う純関数群。
 *
 * ## なぜ web 側で判定するのか
 * デスクトップ版の webview はリモート URL (https://kichijitsu.love-rox.cc/app) を読む
 * 薄いガワで、Rust 側は予定データを一切持っていない (apps/desktop/src-tauri/src/lib.rs
 * 冒頭コメント参照)。Rust 側でスケジュールするには Google 同期・繰り返し展開
 * (sync/mapGoogle.ts の4ビルダー + model/series.ts の RRULE 展開) を Rust に複製する
 * 必要があり、話が桁違いに大きくなる。予定は web 側の IndexedDB / OccurrenceStore に
 * あるので、**判定は web 側で行い、Rust には「この文言で通知を出せ」とだけ頼む**。
 *
 * ## なぜ「予定ごとに setTimeout」ではなく tick 方式なのか
 * 1. 予定は同期のたびに丸ごと書き換わる (applySync.ts の reexpandCurrentWindow)。
 *    予定ごとにタイマーを張ると、同期・移動・削除のたびに張り直しが必要で取りこぼす。
 * 2. トレイ常駐アプリなのでウィンドウを閉じても webview は生き続けるが (lib.rs の
 *    CloseRequested は prevent_close + hide)、隠れた webview のタイマーは OS/WebView に
 *    よって間引かれる。長い setTimeout は当てにできない。
 * 3. スリープ復帰でも setTimeout はずれる。
 * 毎 tick で「いまの壁時計」から判定し直す方式なら、tick が遅れても間引かれても
 * 判定そのものは常に正しい。
 *
 * ## Google 側のリマインダー設定は使っていない
 * Google Calendar API の `reminders` (useDefault / overrides) はこのアプリの同期経路に
 * 一切乗っていない (packages/shared/src/protocol.ts の GoogleEventDTO に該当フィールドが
 * 無く、apps/sync 側の toGoogleEventDTO も読んでいない)。したがってここで出す通知は
 * **アプリ独自の一律の分数**であり、Google 側で予定ごとに設定した通知とは無関係。
 * 利用者が誤解しないよう、設定 UI とドキュメントで明示している
 * (components/SettingsModal.tsx の ReminderControl、apps/site/docs/apps/index.html)。
 */

import { Temporal } from "@js-temporal/polyfill";
import {
  readStored,
  readStoredStringSet,
  writeStored,
  writeStoredStringSet,
  type StorageLike,
} from "../layout/localStore";

/** 通知しない (オフ) を表す分数。設定 UI の「通知しない」がこの値 */
export const REMINDER_LEAD_OFF = 0;

/**
 * 選べる「何分前」の候補。
 *
 * 下限を 5 分にしているのは tick 間隔との兼ね合い ―― 判定窓は
 * 「fireAt <= now < startMs」= 幅ぴったり leadMinutes なので、間引かれた tick でも
 * 確実に窓の中に落ちるだけの幅が要る (REMINDER_TICK_MS の何倍か、という話)。
 * このアプリに `type="number"` の入力が1つも無い流儀 (HourHeightControl と同じく
 * プリセットの select) にも合わせている。
 */
export const REMINDER_LEAD_PRESETS = [5, 10, 15, 30, 60] as const;

/** 既定は 10 分前。通知が来ることを期待して使う人が多いため、既定でオン */
export const DEFAULT_REMINDER_LEAD_MINUTES = 10;

/**
 * 判定 tick の間隔。30 秒。
 * 隠れたウィンドウでタイマーが 1 分程度まで間引かれても、最小プリセット (5 分) の
 * 判定窓には余裕で収まる。1 tick の実務は「近い予定を数十件フィルタする」だけなので安い。
 */
export const REMINDER_TICK_MS = 30_000;

/** 通知済みキーを保持する期間。これより古い開始時刻のキーは捨てる (無限に増えないように) */
export const NOTIFIED_RETENTION_MS = 24 * 60 * 60 * 1000;

const LEAD_STORAGE_KEY = "kichijitsu:reminderLead";
const NOTIFIED_STORAGE_KEY = "kichijitsu:reminderNotified";

/**
 * 判定に必要な予定の最小形。
 *
 * Occurrence (model/types.ts) はこの形を構造的に満たすので、呼び出し側はそのまま渡せる。
 * テストからはこの最小形だけを組み立てればよい (model/types.ts を触らずに済む)。
 */
export interface ReminderCandidate {
  id: string;
  title: string;
  startMs: number;
  /** カレンダーブロックで自動生成した複製。実体の予定と二重に通知しないため除外する */
  isMirror?: boolean;
  /** 「勤務場所」は予定ではないので通知しない */
  isWorkingLocation?: boolean;
  responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
}

/** 「いま通知すべき1件」。title/body はそのままネイティブ通知に渡せる文言 */
export interface DueReminder {
  /** 通知済み記録に使うキー (reminderKey) */
  key: string;
  title: string;
  body: string;
  startMs: number;
}

/**
 * 通知済み記録のキー。**開始時刻を含める**ことが要点。
 *
 * 予定が移動すると startMs が変わってキーも変わるため、移動後の新しい時刻について
 * 改めて通知が出る (移動に通知が追随する)。逆に、リロード・再同期・ウィンドウの開閉を
 * 跨いでも id と startMs が同じなら同じキーになるので二重に通知しない。
 * 削除された予定はそもそも候補に現れないので、何もしなくても通知は止まる。
 *
 * 区切りに `@` を使うが、id 自体にも `@` が入りうる
 * (`g:<accountId>:<calendarId>:<eventId>` の calendarId は
 * `…@group.calendar.google.com` のようなメール形式)。復元は必ず**最後の** `@` で切る。
 */
export function reminderKey(id: string, startMs: number): string {
  return `${id}@${startMs}`;
}

/** reminderKey から開始時刻を取り出す。壊れたキーは null (呼び出し側が捨てる) */
export function parseReminderKeyStartMs(key: string): number | null {
  const at = key.lastIndexOf("@");
  if (at < 0) return null;
  const parsed = Number(key.slice(at + 1));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * そもそも通知の対象になる種類の予定かどうか。
 *
 * 終日予定は候補に入れない ―― この関数には時刻付き予定 (Occurrence) しか渡らない。
 * 終日予定 (AllDayOccurrence) は時刻を持たないため「N 分前」が定義できず、
 * 「前日 23:50 に出す」等は別途の設定項目が必要になるので今回は対象外
 * (ドキュメントに明記)。
 */
export function isReminderTarget(candidate: ReminderCandidate): boolean {
  // 型の上では startMs 必須だが、終日予定 (AllDayOccurrence は startDate だけを持つ) が
  // 何かの経路で混ざったときに「NaN 分前」のような通知を出さないよう実行時にも弾く。
  if (!Number.isFinite(candidate.startMs)) return false;
  if (candidate.isMirror) return false;
  if (candidate.isWorkingLocation) return false;
  // 欠席と答えた予定に通知しても邪魔なだけ
  if (candidate.responseStatus === "declined") return false;
  return true;
}

/** 保存値 → 分数。未知・範囲外の値は既定に落とす */
export function normalizeReminderLead(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed === REMINDER_LEAD_OFF) return REMINDER_LEAD_OFF;
  return (REMINDER_LEAD_PRESETS as readonly number[]).includes(parsed) ? parsed : null;
}

/** 「何分前に通知するか」。0 は通知しない。保存が無い/壊れているときは既定の 10 分 */
export function getReminderLeadMinutes(storage?: StorageLike): number {
  return readStored(
    LEAD_STORAGE_KEY,
    normalizeReminderLead,
    DEFAULT_REMINDER_LEAD_MINUTES,
    storage,
  );
}

export function setReminderLeadMinutes(minutes: number, storage?: StorageLike): void {
  writeStored(LEAD_STORAGE_KEY, String(minutes), storage);
}

/**
 * 通知済みキーの読み書き。
 *
 * IndexedDB の `meta` ではなく localStorage に置いている理由: 同期のたびに
 * occurrences ストアは丸ごと書き換わるため、通知済み記録は予定データの外に置く必要が
 * あり、かつ「この端末でこの通知を出したか」は端末ローカルの話で同期する意味が無い
 * (テーマや gh のパスと同じ層)。
 */
export function getNotifiedKeys(storage?: StorageLike): Set<string> {
  return readStoredStringSet(NOTIFIED_STORAGE_KEY, storage);
}

export function setNotifiedKeys(keys: Set<string>, storage?: StorageLike): void {
  writeStoredStringSet(NOTIFIED_STORAGE_KEY, keys, storage);
}

/**
 * 古い通知済みキーを捨てる。キーが開始時刻を持っているおかげで純関数で書ける。
 * 開始時刻が復元できない壊れたキーもここで落とす。
 */
export function pruneNotifiedKeys(
  notified: ReadonlySet<string>,
  nowMs: number,
  retentionMs: number = NOTIFIED_RETENTION_MS,
): Set<string> {
  const kept = new Set<string>();
  for (const key of notified) {
    const startMs = parseReminderKeyStartMs(key);
    if (startMs === null) continue;
    if (startMs >= nowMs - retentionMs) kept.add(key);
  }
  return kept;
}

/** timeZone での HH:mm */
function formatLocalTime(startMs: number, timeZone: string): string {
  const zoned = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO(timeZone);
  return `${String(zoned.hour).padStart(2, "0")}:${String(zoned.minute).padStart(2, "0")}`;
}

/**
 * 通知の本文。「何時開始か」と「あと何分か」だけ。
 * Google 側の設定を使っていない旨は毎回の通知に書くと騒がしいので、設定 UI と
 * ドキュメント側で明示している (ファイル冒頭コメント参照)。
 */
export function formatReminderBody(startMs: number, nowMs: number, timeZone: string): string {
  const at = formatLocalTime(startMs, timeZone);
  const minutesLeft = Math.round((startMs - nowMs) / 60_000);
  return minutesLeft <= 0 ? `${at} 開始 · まもなく` : `${at} 開始 · あと ${minutesLeft} 分`;
}

export interface SelectDueRemindersArgs {
  candidates: readonly ReminderCandidate[];
  nowMs: number;
  /** 0 (REMINDER_LEAD_OFF) なら常に空を返す */
  leadMinutes: number;
  notified: ReadonlySet<string>;
  timeZone: string;
}

/**
 * 「いまこの tick で通知すべき予定」を開始時刻順に返す。
 *
 * 判定条件は3つだけ:
 * - `startMs - leadMinutes <= now` … 通知時刻に達している
 * - `now < startMs` … **まだ始まっていない**。起動時に過去分が一気に飛ぶ事故を
 *   これ1本で防いでいる (別途の猶予窓は要らない)
 * - キーが通知済み集合に無い … リロード・再同期・ウィンドウ開閉を跨いだ二重通知の防止
 *
 * 「まだ始まっていない予定だけ」なので、たとえ1週間アプリを落としていた後に起動しても
 * 飛ぶのは高々 leadMinutes 以内に始まる数件で、過去分は1件も出ない。
 */
export function selectDueReminders({
  candidates,
  nowMs,
  leadMinutes,
  notified,
  timeZone,
}: SelectDueRemindersArgs): DueReminder[] {
  if (leadMinutes === REMINDER_LEAD_OFF) return [];

  const leadMs = leadMinutes * 60_000;
  const due: DueReminder[] = [];

  for (const candidate of candidates) {
    if (!isReminderTarget(candidate)) continue;
    if (candidate.startMs <= nowMs) continue; // 過去/進行中は対象外
    if (candidate.startMs - leadMs > nowMs) continue; // まだ通知時刻に達していない

    const key = reminderKey(candidate.id, candidate.startMs);
    if (notified.has(key)) continue;

    due.push({
      key,
      title: candidate.title.trim() === "" ? "(タイトルなし)" : candidate.title,
      body: formatReminderBody(candidate.startMs, nowMs, timeZone),
      startMs: candidate.startMs,
    });
  }

  return due.sort((a, b) => a.startMs - b.startMs);
}
