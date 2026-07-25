import type { WorkLogDTO } from "@kichijitsu/shared";
import { issueIdentityNumber, workLogIssueIdentity } from "./workLogGrouping";

/**
 * hook 実績 (docs/mcp.md「エージェントの作業時間記録」) の突合。純関数層、DOM/store には
 * 一切触れない (App.tsx が GET /api/work-logs からの取得と配線を、TimeReportOverlay.tsx が
 * 表示を担当する)。sync/timeTracking.ts (手動タイマー実績) / sync/estimateActual.ts (commit
 * からの推定) と並ぶ「予定 vs 実績」レポートの3つ目の実績経路 — 手動タイマー実績とは完全に
 * 別立てのデータであり、混ぜ込まずレポート側で別列として併記する。
 *
 * D1 保存への移行 (2026-07-21): 当初は occurrences ストア (Google カレンダーの「kichijitsu 実績」
 * イベントを mapGoogle.ts が写したもの) から突合していたが、work-log の保存先が D1 に変わった
 * ため入力を GET /api/work-logs の WorkLogDTO[] に差し替えた。突合ロジック自体は同じ。
 *
 * 突合の考え方: hook 実績 (WorkLogDTO、`{repo, issueRef?}`) は issueRef が単なる文字列
 * (ブランチ名由来等で数値とは限らない) で、PlannedBlock.linkedItemId
 * (`ghq:{repo}:{issue|pr}:{number}`) が issue/pr のどちらかを区別しているのに対し issue/pr の
 * 区別を持たない。そのため「issue 番号が数値のときだけ」repo+number をキーに、呼び出し側が渡す
 * linkedItemId 集合の中から一致するものへ割り当てる(= item 側を正として、
 * repo+number が一致する linkedItemId に実績時間を足し込む)。同じ repo+number で issue と pr の
 * 両方が存在する場合は両方に加算する(区別できない以上、両方に見せておくほうが
 * 取りこぼしより安全という判断)。
 *
 * issue の所属 repo + 番号の正規化は workLogGrouping.ts の workLogIssueIdentity に委譲する
 * (2026-07-25): 以前は `workLog.repo` + 「issueRef が数値」しか見ておらず、hook/MCP が書く
 * `owner/repo#番号` 形式の完全参照 (別 repo の issue を指すケース) を丸ごと取りこぼしていた。
 * 実績履歴 (WorkLogModal/右ペインのグループ表示) は同じ work_log を issue 単位で見せているのに
 * レポートだけ落ちるのは一貫しないため、正規化の流儀をそちらへ揃える。
 */

/** `ghq:{repo}:{issue|pr}:{number}` から repo+number を取り出す。形式が違えば null */
function parseRepoNumber(linkedItemId: string): { repo: string; number: string } | null {
  const m = /^ghq:(.+):(?:issue|pr):(\d+)$/.exec(linkedItemId);
  if (!m) return null;
  return { repo: m[1], number: m[2] };
}

/**
 * 突合キー。番号は Number() を通してから文字列化する — work_log 側の issueRef が "007" のような
 * 桁揃えで来ても linkedItemId 側の 7 と同じキーになるようにするため(両側で同じ関数を通す)。
 */
function repoNumberKey(repo: string, number: string | number): string {
  return `${repo}#${Number(number)}`;
}

/**
 * work_log 1件が指す issue/PR の同一性 (所属 repo + 数値の番号) を返す。番号が数値にならない
 * (ブランチ名由来の issueRef 等) / issueRef 自体が無いものは null。
 *
 * この「どの work_log をどの item に紐づけるか」の判定を hookActualByLinkedItem と
 * reportExport.ts (work_logs 由来のレポート行の生成) で共有するための公開ヘルパー。両者が別々の
 * 正規化を持つと「行は出るのに実績が 0」「実績はあるのに行が無い」という食い違いが起きるため、
 * ルールはここ1箇所に置く。所属 repo + 番号の切り出しと「数値番号のみ」の判定自体は
 * workLogGrouping.ts (実績履歴のグループ化と共通の issueRef 正規化) に委譲する。
 */
export function workLogItemRef(
  workLog: Pick<WorkLogDTO, "repo" | "issueRef">,
): { repo: string; number: number } | null {
  const identity = workLogIssueIdentity(workLog.repo, workLog.issueRef);
  const number = issueIdentityNumber(identity);
  if (number === undefined) return null;
  return { repo: identity.repo, number };
}

/**
 * workLogs のうち issue 番号が数値のものだけを repo+number で itemLinkedItemIds と突き合わせて
 * item (linkedItemId) 単位に実績 ms (endMs-startMs) を合計する。issue 番号が非数値
 * (ブランチ名由来等)・undefined、または repo+number が itemLinkedItemIds のどれとも
 * 一致しないものは集計対象外(取りこぼしはあるが、誤った突合よりは安全側)。
 *
 * 第2引数は当初「予定タイムブロックの linkedItemId 集合」だったが、reportExport.ts が
 * 「予定 ∪ work_logs」の linkedItemId を渡すようになった (2026-07-25) ため、予定に限らない
 * item 側の id 集合という位置づけに広げてある(関数の挙動自体は変えていない)。
 */
export function hookActualByLinkedItem(
  workLogs: WorkLogDTO[],
  itemLinkedItemIds: Iterable<string>,
): Record<string, number> {
  // repo+number ごとに、一致しうる item 側の linkedItemId (issue/pr 両方の可能性) を集める
  const byRepoNumber = new Map<string, string[]>();
  for (const id of itemLinkedItemIds) {
    const parsed = parseRepoNumber(id);
    if (!parsed) continue;
    const key = repoNumberKey(parsed.repo, parsed.number);
    const ids = byRepoNumber.get(key);
    if (ids) {
      if (!ids.includes(id)) ids.push(id);
    } else {
      byRepoNumber.set(key, [id]);
    }
  }

  const result: Record<string, number> = {};
  for (const workLog of workLogs) {
    // issue の所属 repo + 番号は実績履歴のグループ化と同じ正規化を使う
    // (`owner/repo#番号` の完全参照も、作業 repo に対する相対番号も同じキーへ寄せる)
    const ref = workLogItemRef(workLog);
    if (!ref) continue;
    const ids = byRepoNumber.get(repoNumberKey(ref.repo, ref.number));
    if (!ids || ids.length === 0) continue;
    const durationMs = Math.max(0, workLog.endMs - workLog.startMs);
    if (durationMs === 0) continue;
    for (const id of ids) {
      result[id] = (result[id] ?? 0) + durationMs;
    }
  }
  return result;
}
