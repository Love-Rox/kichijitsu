import type { OccurrenceLink, OccurrenceSource } from "./types";

/**
 * 繰り返し予定のシリーズ定義。occurrence への展開は expandSeries が行い、
 * UI がこれを直接読むことはない（設計ドキュメント「RRULE の都度評価はしない」）。
 *
 * dtstart は「壁時計のローカル日時 + IANA タイムゾーン」で持つ。
 * epoch ms にしないのは、繰り返しの反復は壁時計基準（毎週月曜 10:00 は
 * DST を跨いでも 10:00 のまま）で行う必要があるため。
 */
export interface EventSeries {
  id: string;
  title: string;
  color: string;
  /** Occurrence.hasCustomColor と同じ意味。展開時に occurrence へそのまま引き継ぐ */
  hasCustomColor?: boolean;
  source: OccurrenceSource;
  /** 展開された全 occurrence に引き継がれる元リソースへの参照 (Google の htmlLink 等) */
  link?: OccurrenceLink;
  /** Google 由来のみ: どのアカウントのどのカレンダーか (展開時に occurrence へ引き継ぐ) */
  accountId?: string;
  calendarId?: string;
  /** 同一予定の集約キー (Google iCalUID、展開時に occurrence へ引き継ぐ) */
  iCalUID?: string;
  /** ホバー/詳細表示用 (展開時に occurrence へ引き継ぐ) */
  location?: string;
  description?: string;
  /**
   * 不在レール表示 (2026-07-22)。Occurrence.isOutOfOffice と同じ意味 —
   * Google の eventType==='outOfOffice' な繰り返しシリーズかどうか。mapGoogle.ts の
   * buildSeries が付与し、expandSeries が展開後の各 occurrence へそのまま引き継ぐ
   * (hasCustomColor と同じ伝播の仕方)。
   */
  isOutOfOffice?: boolean;
  /**
   * 参加ステータス表示 (RSVP、2026-07-22)。Occurrence.responseStatus と同じ意味 ―― mapGoogle.ts
   * の buildSeries が付与し、expandSeries が展開後の各 occurrence へそのまま引き継ぐ
   * (isOutOfOffice と同じ伝播の仕方: override 側に値があればそれを優先し、無ければこの
   * シリーズ全体の値にフォールバックする)。
   */
  responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  /** Occurrence.isOrganizer と同じ意味(参加ステータス表示、2026-07-22)。isOutOfOffice と同じ伝播。 */
  isOrganizer?: boolean;
  /** Occurrence.hasConference と同じ意味(参加ステータス表示、2026-07-22)。isOutOfOffice と同じ伝播。 */
  hasConference?: boolean;
  /** 初回開始のローカル日時 (タイムゾーンオフセットなしの ISO)。例 "2026-07-20T10:00" */
  dtstartIso: string;
  /** IANA タイムゾーン。例 "Asia/Tokyo" */
  timeZone: string;
  durationMin: number;
  /**
   * RRULE 本体 ("RRULE:" プレフィックスなし)。例 "FREQ=WEEKLY;BYDAY=MO,WE"
   * 対応サブセット: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY
   * (WEEKLY の曜日リスト / MONTHLY の 2TU・-1FR 形式), BYMONTHDAY, UNTIL, COUNT
   */
  rrule: string;
  /** 除外する回の「元の開始時刻 (epoch ms)」のリスト (EXDATE 相当) */
  exdatesMs: number[];
}

/**
 * シリーズ内の個別インスタンスへの上書き。シリーズ定義とは別レイヤーで持つ
 * (設計ドキュメント「例外の扱い」)。「この予定のみ」編集の実体。
 */
export interface InstanceOverride {
  /** `${seriesId}:${originalStartMs}` — occurrence の id と同じ規則 */
  id: string;
  seriesId: string;
  /** 展開で得られる元の開始時刻 (epoch ms)。どの回への上書きかを示す */
  originalStartMs: number;
  /** null ならこの回はキャンセル (削除)。それ以外は部分上書き */
  patch: {
    title?: string;
    startMs?: number;
    endMs?: number;
    color?: string;
    location?: string;
    description?: string;
    /**
     * 不在レール表示 (2026-07-22)。この例外インスタンス自体が eventType==='outOfOffice' の
     * ときのみ true をセットする (mapGoogle.ts の buildOverride)。false や undefined で
     * 明示的に「不在ではない」を上書きするケースは v1 では扱わない — 立てないときは
     * キー自体を省略し、expandSeries 側でシリーズの isOutOfOffice にフォールバックさせる。
     */
    isOutOfOffice?: boolean;
    /**
     * 参加ステータス表示 (RSVP、2026-07-22)。この例外インスタンス自体が持つ selfResponseStatus
     * を上書きするときのみセットする(isOutOfOffice と同じ流儀: セットしないケースでは
     * キー自体を省略し、expandSeries 側でシリーズの responseStatus にフォールバックさせる)。
     */
    responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
    /** isOutOfOffice と同じ流儀(この例外インスタンス自体が isOrganizer===true のときのみ true をセット) */
    isOrganizer?: boolean;
    /** isOutOfOffice と同じ流儀(この例外インスタンス自体が hasConference===true のときのみ true をセット) */
    hasConference?: boolean;
  } | null;
}

/** occurrence / override 共通の id 規則 */
export function instanceId(seriesId: string, originalStartMs: number): string {
  return `${seriesId}:${originalStartMs}`;
}
