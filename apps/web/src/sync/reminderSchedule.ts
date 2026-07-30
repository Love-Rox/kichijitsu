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
 * ## Google 側のリマインダー設定を尊重する (2026-07-31)
 * 予定ごとの `reminders` (useDefault / overrides) を同期するようにしたので、既定では
 * **Google 側で予定ごとに設定した通知をそのまま使う** (ReminderMode の "google")。
 * 「一律◯分前」も設定として残してあるが、そちらを選んだときは Google 側の設定を無視する。
 *
 * Google 側の設定を「実際に何分前か」へ解決する経路は3つある (resolveLeadMinutes 参照):
 *   - `{ minutes: [...] }` … その予定に直接設定された popup リマインダー (最大5件)
 *   - `{ useDefault: true }` … カレンダーの既定リマインダー。分数は予定側には**入っておらず**、
 *     カレンダー一覧 (CalendarListEntryDTO.defaultReminderMinutes) から来る
 *   - 未同期 (undefined) … 世代7のバックフィルが済むまでの過渡期。カレンダー既定として扱う
 *
 * `email` のリマインダーは載っていない (apps/sync の derivePopupReminderMinutes で落としている)。
 * Google 自身がメールを送るので、同じ時刻にデスクトップ通知を重ねる意味が無いため。
 */

import { Temporal } from "@js-temporal/polyfill";
import { calendarKeyOf } from "../layout/keys";
import type { EventReminders } from "../model/types";
import {
  readStored,
  readStoredStringSet,
  writeStored,
  writeStoredStringSet,
  type StorageLike,
} from "../layout/localStore";

/**
 * 「何分前に通知するか」の決め方 (端末ローカルの設定)。
 *
 * - `google` … 予定ごと (無ければカレンダーごと) の Google の設定に従う。**既定**
 * - `off`    … 一切通知しない
 * - `fixed`  … Google の設定を無視して一律 minutes 分前
 *
 * 分数そのものではなく種別を持つ形にしたのは、旧実装が「0 = 通知しない」を分数と同じ
 * 名前空間に置いていたため ―― Google のリマインダーは **0 分 (開始時刻ちょうど)** が
 * 正当な値なので、そのままでは「通知しない」と衝突する。
 */
export type ReminderMode =
  | { kind: "google" }
  | { kind: "off" }
  | { kind: "fixed"; minutes: number };

/** 設定を触っていない利用者の既定。カレンダーアプリとして素直なのは Google 側に従うこと */
export const DEFAULT_REMINDER_MODE: ReminderMode = { kind: "google" };

/**
 * 「一律◯分前」で選べる候補。
 *
 * 下限を 5 分にしているのは tick 間隔との兼ね合い ―― 判定窓は
 * 「fireAt <= now < startMs」= 幅ぴったり leadMinutes なので、間引かれた tick でも
 * 確実に窓の中に落ちるだけの幅が要る (REMINDER_TICK_MS の何倍か、という話)。
 * このアプリに `type="number"` の入力が1つも無い流儀 (HourHeightControl と同じく
 * プリセットの select) にも合わせている。
 *
 * Google 側から来る分数はこの候補に縛られない (0 分や 1440 分もそのまま扱う)。
 * ここはあくまで**利用者が手で選ぶときの**選択肢。
 */
export const REMINDER_LEAD_PRESETS = [5, 10, 15, 30, 60] as const;

/** 「一律◯分前」を選んだときの初期表示。旧実装の既定値と同じ */
export const DEFAULT_FIXED_LEAD_MINUTES = 10;

/**
 * Google 側の設定として尊重する分数の上限 (24 時間)。
 *
 * Google の仕様上の上限は 40320 分 (4週間) だが、そこまで尊重しない:
 * このアプリの通知は**アプリが起動している瞬間に壁時計で判定する**方式なので、
 * 数日前の通知を確実に出すことはそもそもできず、代わりに「起動した瞬間に数十件の
 * 予定の通知が一斉に飛ぶ」副作用だけが大きくなる。
 *
 * 上限を超えたリマインダーは**切り詰めずに落とす** ―― 「1週間前」を24時間前に丸めて
 * 出すのは利用者が設定していない時刻に鳴らすことであり、出さないより悪い。
 * この線引きは設定 UI とドキュメントに明記している。
 */
export const MAX_HONORED_LEAD_MINUTES = 1440;

/**
 * 判定 tick の間隔。30 秒。
 * 隠れたウィンドウでタイマーが 1 分程度まで間引かれても、最小プリセット (5 分) の
 * 判定窓には余裕で収まる。1 tick の実務は「近い予定を数十件フィルタする」だけなので安い。
 */
export const REMINDER_TICK_MS = 30_000;

/**
 * 「通知時刻を過ぎていても、これだけ遅れていれば諦める」猶予 (15 分)。
 *
 * これが無いと、長いリマインダー (例: 1日前) を設定した予定が、アプリを起動した瞬間に
 * **まとめて**飛んでくる ―― 判定条件の `fireAt <= now < startMs` は「通知時刻を過ぎていて
 * まだ始まっていない」を意味するだけなので、リード幅が長いほど「過ぎている」予定が増える。
 *
 * 15 分にしてあるのは、
 *   - 旧来の既定 (10 分前) を含む 15 分以内のリマインダーでは**判定窓のほうが狭く、
 *     この条件が一度も効かない** = 既存利用者の見え方が変わらない
 *   - 30 秒 tick の間引き・スリープ復帰のずれは十分に吸収できる
 * の2点から。長いリマインダーでだけ効いて、一斉通知を「直近15分ぶん」に抑える。
 */
export const REMINDER_CATCHUP_MS = 15 * 60_000;

/**
 * 毎 tick で store から読む先読み範囲。上限リマインダー + tick 1回分の余裕。
 * 上限 (MAX_HONORED_LEAD_MINUTES) から導出しているので、上限を変えればここも追従する。
 */
export const REMINDER_LOOKAHEAD_MS = MAX_HONORED_LEAD_MINUTES * 60_000 + REMINDER_TICK_MS;

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
  /** Google 側の予定ごとのリマインダー設定 (2026-07-31)。resolveLeadMinutes が解決する */
  reminders?: EventReminders;
  /** `reminders` が `{ useDefault: true }` のとき、どのカレンダーの既定を引くかの手掛かり */
  accountId?: string;
  calendarId?: string;
}

/**
 * カレンダーごとの既定リマインダー (popup の分数)。キーは layout/keys.ts の
 * `calendarKey(accountId, calendarId)`。値は CalendarListEntryDTO.defaultReminderMinutes。
 */
export type CalendarDefaultReminders = ReadonlyMap<string, readonly number[]>;

/** 「いま通知すべき1件」。title/body はそのままネイティブ通知に渡せる文言 */
export interface DueReminder {
  /** 通知済み記録に使うキー (reminderKey) */
  key: string;
  title: string;
  body: string;
  startMs: number;
  /** この通知が「何分前」のものか。1つの予定から複数出るので区別が要る */
  leadMinutes: number;
}

/**
 * 通知済み記録のキー。**開始時刻と分数を含める**ことが要点。
 *
 * 予定が移動すると startMs が変わってキーも変わるため、移動後の新しい時刻について
 * 改めて通知が出る (移動に通知が追随する)。逆に、リロード・再同期・ウィンドウの開閉を
 * 跨いでも id と startMs が同じなら同じキーになるので二重に通知しない。
 * 削除された予定はそもそも候補に現れないので、何もしなくても通知は止まる。
 *
 * 分数を含めるのは、Google では1つの予定に**複数のリマインダー**を設定できるため
 * (公式の上限は5件)。「1時間前」と「10分前」の両方が設定されている予定で、分数を
 * キーに含めないと、1時間前の通知を出した時点で予定ごと通知済みになり、肝心の
 * 10分前が永久に出なくなる。
 *
 * 分数を**先頭**に置いてあるのは、`parseReminderKeyStartMs` の復元 (最後の `@` で切る) を
 * そのまま使えるようにするため。区切りに `@` を使うが、id 自体にも `@` が入りうる
 * (`g:<accountId>:<calendarId>:<eventId>` の calendarId は
 * `…@group.calendar.google.com` のようなメール形式)。復元は必ず**最後の** `@` で切る。
 * (旧形式 `${id}@${startMs}` のキーも同じ規則で開始時刻を復元でき、prune は素通しできる)
 */
export function reminderKey(id: string, startMs: number, leadMinutes: number): string {
  return `${leadMinutes}#${id}@${startMs}`;
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

/**
 * 保存値 → ReminderMode。未知・壊れた値は null (呼び出し側が既定に落とす)。
 *
 * **旧形式 (数字のみ) を受け付ける**のが要点。2026-07-30 の初版はこのキーに
 * "0"(通知しない) / "5" / "10" / "15" / "30" / "60" を書いていたので、
 *   - "0"      → 通知しない (利用者が明示的に切ったのだから尊重する)
 *   - "5".."60"→ 一律◯分前 (利用者が明示的に選んだ分数をそのまま維持する)
 * へ読み替える。**保存が無い場合だけ**新しい既定 ("google") になる ―― 設定画面を
 * 一度も触っていない人は「Google に従う」へ、自分で選んだ人はその選択のまま、という
 * 切り分け。
 */
export function parseReminderMode(raw: string | null | undefined): ReminderMode | null {
  if (raw === null || raw === undefined) return null;
  if (raw === "google") return { kind: "google" };
  if (raw === "off") return { kind: "off" };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  // 旧形式: 0 は「通知しない」だった
  if (parsed === 0) return { kind: "off" };
  return (REMINDER_LEAD_PRESETS as readonly number[]).includes(parsed)
    ? { kind: "fixed", minutes: parsed }
    : null;
}

/** ReminderMode → 保存値 (旧形式と同じキーに書くので、数値は数字のまま書く) */
export function serializeReminderMode(mode: ReminderMode): string {
  if (mode.kind === "google") return "google";
  if (mode.kind === "off") return "off";
  return String(mode.minutes);
}

/** 「何分前に通知するか」の決め方。保存が無い/壊れているときは既定 (Google に従う) */
export function getReminderMode(storage?: StorageLike): ReminderMode {
  return readStored(LEAD_STORAGE_KEY, parseReminderMode, DEFAULT_REMINDER_MODE, storage);
}

export function setReminderMode(mode: ReminderMode, storage?: StorageLike): void {
  writeStored(LEAD_STORAGE_KEY, serializeReminderMode(mode), storage);
}

/**
 * 分数リストの正規化: 整数でない / 負 / 上限超えを落とし、重複を除いて昇順にする。
 * サーバー側 (apps/sync の derivePopupReminderMinutes) でも同じ絞り込みをしているが、
 * ここは**上限が違う** (Google の 40320 分ではなくアプリの 1440 分) ので独立して必要。
 */
function normalizeLeadMinutes(minutes: readonly number[]): number[] {
  const kept = new Set<number>();
  for (const value of minutes) {
    if (!Number.isInteger(value)) continue;
    if (value < 0 || value > MAX_HONORED_LEAD_MINUTES) continue;
    kept.add(value);
  }
  return [...kept].sort((a, b) => a - b);
}

/**
 * 「この予定に対して、何分前の通知を出すか」を解決する (2026-07-31)。**この関数が今回の要**。
 *
 * 返すのは分数の配列 ―― Google では1つの予定に複数のリマインダー (「1時間前」と「10分前」の
 * 両方など) を設定でき、**全部出す**方針にしたため。片方を黙って捨てるのは、まさに今回
 * 直している「Google が返しているのに捨てている」と同じ過ちになる。
 *
 * mode ごとの意味:
 *   - `off`    … 常に空。予定側の設定に関わらず1件も出さない
 *   - `fixed`  … 常にその1件。**Google 側の設定は見ない**(旧来の挙動をそのまま選べるように残した)
 *   - `google` … 予定ごとの設定に従う。内訳は下記
 *
 * `google` のときの解決:
 *   - `{ minutes: [...] }` … その予定に直接設定された popup リマインダー。**空配列なら通知しない**
 *     (「リマインダーを1つも設定していない」という積極的な設定なので、勝手に補わない)
 *   - `{ useDefault: true }` … カレンダーの既定リマインダー。分数は予定側に無いので
 *     calendarDefaults から引く。引けなければ空 (カレンダー一覧が未取得・既定が空のカレンダー)
 *   - `undefined` … カレンダー既定と同じ扱いにする。ここに来るのは (a) 世代7のバックフィルが
 *     済むまでの過渡期の予定、(b) Google 由来でない予定 (kichijitsu 内で作った予定・デモ)。
 *     (a) では Google 上のほとんどの予定が実際に useDefault なので、これが最も近い推測であり、
 *     かつ「バックフィルが終わるまで通知が全部止まる」という一番驚く壊れ方を避けられる。
 *     (b) は accountId/calendarId を持たないので結局空になり、実害が無い。
 */
export function resolveLeadMinutes(
  candidate: ReminderCandidate,
  mode: ReminderMode,
  calendarDefaults?: CalendarDefaultReminders,
): number[] {
  if (mode.kind === "off") return [];
  if (mode.kind === "fixed") return normalizeLeadMinutes([mode.minutes]);

  const reminders = candidate.reminders;
  if (reminders && "minutes" in reminders) return normalizeLeadMinutes(reminders.minutes);
  return normalizeLeadMinutes(calendarDefaults?.get(calendarKeyOf(candidate)) ?? []);
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
 *
 * 「何分前の設定によるものか」は書かない ―― 1つの予定に複数のリマインダーが立つ場合
 * (「1時間前」と「10分前」) でも、実際の残り時間が本文に出るので読めば区別が付く。
 * 設定に由来する説明は毎回の通知に載せると騒がしいので、設定 UI とドキュメント側に置く。
 */
export function formatReminderBody(startMs: number, nowMs: number, timeZone: string): string {
  const at = formatLocalTime(startMs, timeZone);
  const minutesLeft = Math.round((startMs - nowMs) / 60_000);
  return minutesLeft <= 0 ? `${at} 開始 · まもなく` : `${at} 開始 · あと ${minutesLeft} 分`;
}

export interface SelectDueRemindersArgs {
  candidates: readonly ReminderCandidate[];
  nowMs: number;
  /** 「何分前に出すか」の決め方。`{ kind: "off" }` なら常に空を返す */
  mode: ReminderMode;
  /** `{ useDefault: true }` の予定を解決するためのカレンダーごとの既定 */
  calendarDefaults?: CalendarDefaultReminders;
  notified: ReadonlySet<string>;
  timeZone: string;
}

/**
 * 「いまこの tick で通知すべき予定」を開始時刻順に返す。
 *
 * 予定 × その予定のリマインダー分数の総当たりで、次の4条件を全て満たすものを返す:
 * - `startMs - lead <= now` … 通知時刻に達している
 * - `now < startMs` … **まだ始まっていない**。過去の予定の通知は1件も出さない
 * - `now - fireAt <= REMINDER_CATCHUP_MS` … 通知時刻から**大幅に遅れていない**。
 *   長いリマインダー (1日前など) を尊重するようにしたぶん、これが無いと起動した瞬間に
 *   「もう通知時刻を過ぎている」予定がまとめて飛ぶ (定数側のコメント参照)
 * - キーが通知済み集合に無い … リロード・再同期・ウィンドウ開閉を跨いだ二重通知の防止
 *
 * **0 分 (開始時刻ちょうど) のリマインダー**は、判定が 30 秒 tick である以上ぴったりには
 * 出せない。かといって `fireAt = startMs` のままだと窓の幅が 0 になって永久に出ないので、
 * 実効のリード幅を最低 1 tick 分だけ取る ―― 開始の直前 (30 秒以内) に「まもなく」として
 * 出る。5 分以上のリマインダーではこの下駄は一切効かない。
 */
export function selectDueReminders({
  candidates,
  nowMs,
  mode,
  calendarDefaults,
  notified,
  timeZone,
}: SelectDueRemindersArgs): DueReminder[] {
  if (mode.kind === "off") return [];

  const due: DueReminder[] = [];

  for (const candidate of candidates) {
    if (!isReminderTarget(candidate)) continue;
    if (candidate.startMs <= nowMs) continue; // 過去/進行中は対象外

    for (const leadMinutes of resolveLeadMinutes(candidate, mode, calendarDefaults)) {
      // 0 分でも窓が潰れないよう、実効のリード幅は最低 1 tick 分
      const fireAt = candidate.startMs - Math.max(leadMinutes * 60_000, REMINDER_TICK_MS);
      if (fireAt > nowMs) continue; // まだ通知時刻に達していない
      if (nowMs - fireAt > REMINDER_CATCHUP_MS) continue; // 遅れすぎ (一斉通知の抑止)

      const key = reminderKey(candidate.id, candidate.startMs, leadMinutes);
      if (notified.has(key)) continue;

      due.push({
        key,
        title: candidate.title.trim() === "" ? "(タイトルなし)" : candidate.title,
        body: formatReminderBody(candidate.startMs, nowMs, timeZone),
        startMs: candidate.startMs,
        leadMinutes,
      });
    }
  }

  // 開始時刻順。同じ予定に複数のリマインダーが同時に立つことは実際上ほぼ無いが、
  // 起きたときに順序が不定にならないよう分数でも並べる (短い = 差し迫っているほうを先に)
  return due.sort((a, b) => a.startMs - b.startMs || a.leadMinutes - b.leadMinutes);
}
