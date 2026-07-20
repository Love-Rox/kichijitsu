import type { Occurrence } from "../model/types";

/**
 * hook 実績 (docs/mcp.md「エージェントの作業時間記録」) の突合。純関数層、DOM/store には
 * 一切触れない (App.tsx が occurrences ストアからの取り出しと配線を、TimeReportOverlay.tsx が
 * 表示を担当する)。sync/timeTracking.ts (手動タイマー実績) / sync/estimateActual.ts (commit
 * からの推定) と並ぶ「予定 vs 実績」レポートの3つ目の実績経路 — 手動タイマー実績とは完全に
 * 別立てのデータであり、混ぜ込まずレポート側で別列として併記する。
 *
 * 突合の考え方: hook 実績イベント (mapGoogle.ts が写す occurrence.workLog、`{repo, issueRef?}`)
 * は issueRef が単なる文字列 (ブランチ名由来等で数値とは限らない) で、PlannedBlock.linkedItemId
 * (`ghq:{repo}:{issue|pr}:{number}`) が issue/pr のどちらかを区別しているのに対し issue/pr の
 * 区別を持たない。そのため「issueRef が数値のときだけ」repo+number をキーに、呼び出し側が渡す
 * planned 側の linkedItemId 集合の中から一致するものへ割り当てる(= planned 側を正として、
 * repo+number が一致する linkedItemId に実績時間を足し込む)。同じ repo+number で issue と pr の
 * 両方が planned に存在する場合は両方に加算する(区別できない以上、両方に見せておくほうが
 * 取りこぼしより安全という判断)。
 */

/** `ghq:{repo}:{issue|pr}:{number}` から repo+number を取り出す。形式が違えば null */
function parseRepoNumber(linkedItemId: string): { repo: string; number: string } | null {
  const m = /^ghq:(.+):(?:issue|pr):(\d+)$/.exec(linkedItemId);
  if (!m) return null;
  return { repo: m[1], number: m[2] };
}

/**
 * occurrences のうち workLog を持つものを集め、issueRef が数値の場合のみ repo+number で
 * plannedLinkedItemIds と突き合わせて item (linkedItemId) 単位に実績 ms (endMs-startMs) を
 * 合計する。issueRef が非数値(ブランチ名由来等)・undefined、または repo+number が
 * plannedLinkedItemIds のどれとも一致しないものは集計対象外(取りこぼしはあるが、
 * 誤った突合よりは安全側)。
 */
export function hookActualByLinkedItem(
  occurrences: Occurrence[],
  plannedLinkedItemIds: Iterable<string>,
): Record<string, number> {
  // repo+number ごとに、一致しうる planned 側の linkedItemId (issue/pr 両方の可能性) を集める
  const byRepoNumber = new Map<string, string[]>();
  for (const id of plannedLinkedItemIds) {
    const parsed = parseRepoNumber(id);
    if (!parsed) continue;
    const key = `${parsed.repo}#${parsed.number}`;
    const ids = byRepoNumber.get(key);
    if (ids) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      byRepoNumber.set(key, [id]);
    }
  }

  const result: Record<string, number> = {};
  for (const occ of occurrences) {
    const workLog = occ.workLog;
    if (!workLog?.issueRef || !/^\d+$/.test(workLog.issueRef)) continue;
    const ids = byRepoNumber.get(`${workLog.repo}#${workLog.issueRef}`);
    if (!ids || ids.length === 0) continue;
    const durationMs = Math.max(0, occ.endMs - occ.startMs);
    if (durationMs === 0) continue;
    for (const id of ids) {
      result[id] = (result[id] ?? 0) + durationMs;
    }
  }
  return result;
}
