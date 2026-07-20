import type { BlockMode, GoogleEventDTO } from "@kichijitsu/shared";

/**
 * block_mirrors テーブルの1行 (対応表)。内容は保存しない原則により
 * ID と時刻のみを持つ (docs/blocking.md 確定設計)。
 */
export interface BlockMirrorRow {
  rule_id: string;
  source_event_id: string;
  mirror_event_id: string;
  source_updated: string | null;
  created_at: number;
}

/**
 * 生成した mirror イベントに立てる extendedProperties.private のキー/値。
 * これが付いた予定は「どのルールの source 集合からも除外」することで
 * mirror が別ルールの source になる無限ループを防ぐ (docs/blocking.md)。
 */
export const MIRROR_MARKER_KEY = "kichijitsuMirror";
const MIRROR_MARKER_VALUE = "1";

/** 与えられたイベントが (このシステムが生成した) mirror かどうか。 */
export function isMirrorEvent(event: GoogleEventDTO): boolean {
  return event.extendedProperties?.private?.[MIRROR_MARKER_KEY] === MIRROR_MARKER_VALUE;
}

/** start/end とも dateTime か date のいずれかを持ち、複製可能な時間帯を表しているか。 */
function hasUsableTime(event: GoogleEventDTO): boolean {
  const start = event.start;
  const end = event.end;
  if (!start || !end) return false;
  const startOk = Boolean(start.dateTime) || Boolean(start.date);
  const endOk = Boolean(end.dateTime) || Boolean(end.date);
  return startOk && endOk;
}

/** source イベントが「今も複製すべき」状態か (キャンセル済み・時間帯無しでない)。 */
function isLiveSource(event: GoogleEventDTO): boolean {
  return event.status !== "cancelled" && hasUsableTime(event);
}

/** リコンサイル結果: source 集合と既存 mirror を突き合わせて必要な操作を分類したもの。 */
export interface ReconcilePlan {
  /** mirror が存在しない live source。ここから buildMirrorEventBody で新規作成する */
  toCreate: GoogleEventDTO[];
  /** mirror はあるが source が更新された組。時刻を patch する */
  toPatch: { mirror: BlockMirrorRow; source: GoogleEventDTO }[];
  /** 対応する live source が無くなった mirror。削除する */
  toDelete: BlockMirrorRow[];
}

/**
 * source カレンダーの現予定集合と既存 mirror 対応表を突き合わせ、
 * create/patch/delete の差分を計算する純関数 (副作用なし)。
 *
 * - ループ防止: sourceEvents から mirror 自身 (isMirrorEvent) を除外する
 * - 複製対象は cancelled でなく start/end を持つ「live」source のみ
 * - 同一 source_event_id が複数あれば入力順で最初の1件を採用する (安定化)
 */
export function reconcileBlockRule(
  sourceEvents: GoogleEventDTO[],
  mirrors: BlockMirrorRow[],
): ReconcilePlan {
  // ループ防止: mirror 自身は決して source として扱わない
  const nonMirrorEvents = sourceEvents.filter((event) => !isMirrorEvent(event));

  // 重複 source id は最初の1件を採用し、入力順を保つ
  const dedupedSources: GoogleEventDTO[] = [];
  const seenIds = new Set<string>();
  for (const event of nonMirrorEvents) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    dedupedSources.push(event);
  }

  const mirrorBySourceId = new Map<string, BlockMirrorRow>();
  for (const mirror of mirrors) {
    if (!mirrorBySourceId.has(mirror.source_event_id)) {
      mirrorBySourceId.set(mirror.source_event_id, mirror);
    }
  }

  const toCreate: GoogleEventDTO[] = [];
  const toPatch: { mirror: BlockMirrorRow; source: GoogleEventDTO }[] = [];
  const liveSourceIds = new Set<string>();

  for (const source of dedupedSources) {
    if (!isLiveSource(source)) continue;
    liveSourceIds.add(source.id);
    const mirror = mirrorBySourceId.get(source.id);
    if (!mirror) {
      toCreate.push(source);
      continue;
    }
    if (mirror.source_updated !== (source.updated ?? null)) {
      toPatch.push({ mirror, source });
    }
  }

  const toDelete: BlockMirrorRow[] = [];
  for (const mirror of mirrors) {
    if (!liveSourceIds.has(mirror.source_event_id)) {
      toDelete.push(mirror);
    }
  }

  return { toCreate, toPatch, toDelete };
}

/** Google events.insert に渡せる最小限のイベント本体。内容 (location/description 等) は含めない。 */
export interface MirrorEventBody {
  summary: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  transparency: "opaque";
  visibility: "private";
  extendedProperties: { private: Record<string, string> };
  /** mode==='outOfOffice' のときのみ付与する */
  eventType?: "outOfOffice";
}

/**
 * source イベントから mirror イベント本体を組み立てる。時間帯のみを写し、
 * タイトルは固定「予定あり」、location/description/attendees 等の内容は
 * 一切写さない (無内容原則、docs/blocking.md)。
 */
export function buildMirrorEventBody(source: GoogleEventDTO, mode: BlockMode): MirrorEventBody {
  const body: MirrorEventBody = {
    summary: "予定あり",
    start: { ...source.start },
    end: { ...source.end },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: { private: { [MIRROR_MARKER_KEY]: MIRROR_MARKER_VALUE } },
  };
  if (mode === "outOfOffice") {
    body.eventType = "outOfOffice";
  }
  return body;
}
