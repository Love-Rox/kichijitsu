import { instanceId, type InstanceOverride } from "../model/series";

/**
 * シリーズ由来の1回分に対する InstanceOverride の「宛先」と patch のマージ規則だけを
 * 切り出した純関数(リファクタリング フェーズ2 ④、2026-07-25)。
 *
 * なぜ切り出したか: ドラッグ確定 (handlePersist)・編集フォーム保存 (handleEditSave)・
 * RSVP (handleRsvp) の3箇所が、同じ「override の id を導く → 既存 override を読む →
 * **既存 patch を保ったまま** 一部のキーだけ上書きして書き戻す」を各々インラインで
 * 書いていた。ここは実際にバグを踏んだ場所で(既存 patch を丸ごと置き換えてしまうと
 * mapGoogle が例外インスタンスから写した conferenceUrl / hasConference / responseStatus /
 * isOrganizer / isWorkingLocation や、編集フォームが書いた title/location/description が
 * 消え、再展開でシリーズ側の値へ化ける)、判定と合成をテストで固めておく価値が高い。
 */

/** InstanceOverride.patch の「部分上書き」側(patch: null = この回のキャンセル、は含まない)。 */
export type OverridePatchFields = NonNullable<InstanceOverride["patch"]>;

/**
 * override の宛先。id と (seriesId, originalStartMs) を1つの値にまとめてあるので、
 * 呼び出し側は `if (ref)` の1回のガードだけで3つとも使える
 * (切り出し前は `overrideId && seriesId && originalStartMs !== undefined` を毎回書いていた)。
 * InstanceOverride から patch を除いた形なので、`{ ...ref, patch: ... }` でそのまま組める。
 */
export type OverrideRef = Omit<InstanceOverride, "patch">;

/** resolveOverrideRef が必要とする最小形(Occurrence / AllDayOccurrence の共通部分)。 */
export interface OverrideSubject {
  /** 繰り返しシリーズ由来なら親 series の id、単発なら null */
  seriesId?: string | null;
  /** シリーズ由来の場合のみ: 展開時の元の開始時刻 (epoch ms) */
  originalStartMs?: number;
}

/**
 * この occurrence に対応する override の宛先。単発予定 (seriesId が無い) や、
 * シリーズ由来でも originalStartMs を持たない(= どの回への上書きか特定できない)場合は
 * undefined ―― 呼び出し側は override を一切読み書きしない。
 */
export function resolveOverrideRef(subject: OverrideSubject): OverrideRef | undefined {
  const { seriesId, originalStartMs } = subject;
  if (!seriesId || originalStartMs === undefined) return undefined;
  return { id: instanceId(seriesId, originalStartMs), seriesId, originalStartMs };
}

/**
 * 既存 override の patch を保ったまま、fields のキーだけを上書きした InstanceOverride を作る。
 *
 *  - existing が無い(まだ override が無い)ときは fields だけの patch になる。
 *  - existing.patch が null(この回はキャンセル済み)のときも空の patch 扱いにする
 *    ―― 切り出し前の `existing?.patch ?? {}` と同じ(null のスプレッドは何も足さない)。
 *  - fields に値 undefined で入っているキーは、そのまま undefined で上書きされる
 *    (編集フォームの `location: draft.location || undefined` = 空文字なら消す、が該当)。
 */
export function mergeOverridePatch({
  ref,
  existing,
  fields,
}: {
  ref: OverrideRef;
  /** getOverride の結果。未取得/存在しない場合は null/undefined */
  existing: InstanceOverride | null | undefined;
  fields: OverridePatchFields;
}): InstanceOverride {
  // null/undefined のスプレッドは何も足さないため、切り出し前の `existing?.patch ?? {}` から
  // 空オブジェクトのフォールバックを落としてある(挙動は同じ。lint: no-useless-fallback-in-spread)
  return {
    ...ref,
    patch: { ...existing?.patch, ...fields },
  };
}
