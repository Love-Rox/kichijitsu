import type { GitHubItemDTO } from "@kichijitsu/shared";
import type { GitHubItem } from "../model/types";

/**
 * GitHub 連携 (docs/github-integration.md フェーズ①Part B) の DTO→ローカルモデル変換・
 * 表示整形の純関数層(mapGoogle.ts/mapTasks.ts と同じ考え方)。副作用を持たないため
 * WeekGrid.tsx からは呼ぶだけ(レイアウトの分岐ロジックはここに集約してテストする)。
 */

/**
 * GitHubItemDTO[] → GitHubItem[]。DTO とフィールド構成が完全に一致するため
 * (id/type/title/dateMs/repo/number/url/milestoneTitle)、変換は素通しのコピーのみ。
 * それでも wire DTO と保存用モデルをあえて型として分離する(model/types.ts のコメント参照)。
 */
export function mapGitHubItems(items: GitHubItemDTO[]): GitHubItem[] {
  return items.map((item) => ({ ...item }));
}

/** 1日ぶんの GitHubItem を milestone ごとにまとめたグループ */
export interface GitHubMilestoneGroup {
  /** グルーピングキー: repo + milestoneTitle (同名 milestone が別 repo にあっても衝突しない) */
  key: string;
  repo: string;
  milestoneTitle: string;
  /** その日の milestone 項目自体(type='milestone')。同日に無ければ null */
  milestone: GitHubItem | null;
  /** milestone に属する issue/PR 項目(その日ぶん、GitHub 応答順を保持) */
  children: GitHubItem[];
}

function milestoneGroupKey(repo: string, milestoneTitle: string): string {
  return `${repo}::${milestoneTitle}`;
}

/**
 * 1日ぶんの GitHubItem[] を milestone ごとにグルーピングする。milestone 自身の項目が
 * 無い(取りこぼし・フィルタ漏れ等)issue/PR も milestoneTitle だけでグループ化されるため
 * 表示は崩れない。milestoneTitle が無い issue/PR は「milestone なし」としてまとめる
 * (GitHubItemDTO の実運用では milestone 配下の issue/PR しか流れてこない想定だが、
 * 型上は optional のため防御的に扱う)。
 *
 * release(docs/github-integration.md フェーズ④「first cut」、2026-07-20)は milestone
 * と無関係な独立アイテムのため、milestone 同様スキップする — layoutGitHubDay 側で
 * 別リストとして取り出す(「milestone なし」グループに紛れ込ませない)。
 *
 * グループの出現順: milestone 項目が現れた順(先着) → milestoneTitle だけの child から
 * 新規グループが作られた順。同一グループ内の children は入力順を保つ。
 */
export function groupGitHubItemsByMilestone(items: GitHubItem[]): GitHubMilestoneGroup[] {
  const groups = new Map<string, GitHubMilestoneGroup>();
  const order: string[] = [];

  function groupFor(repo: string, milestoneTitle: string): GitHubMilestoneGroup {
    const key = milestoneGroupKey(repo, milestoneTitle);
    let group = groups.get(key);
    if (!group) {
      group = { key, repo, milestoneTitle, milestone: null, children: [] };
      groups.set(key, group);
      order.push(key);
    }
    return group;
  }

  for (const item of items) {
    if (item.type !== "milestone") continue;
    groupFor(item.repo, item.title).milestone = item;
  }

  for (const item of items) {
    if (item.type === "milestone" || item.type === "release") continue;
    const milestoneTitle = item.milestoneTitle ?? "(milestone なし)";
    groupFor(item.repo, milestoneTitle).children.push(item);
  }

  return order.map((key) => groups.get(key)!);
}

/** GitHubLane が実際に描画する1日ぶんの内容(表示件数の上限適用済み) */
export interface GitHubDayLayout {
  visibleGroups: GitHubMilestoneGroup[];
  /** その日の release 項目 (milestone グループに属さない独立アイテム、応答順を保持) */
  releases: GitHubItem[];
  /** 上限を超えて非表示になった項目数 (milestone 見出し + issue/PR チップの合計、release は含まない) */
  overflowCount: number;
}

/** 1日に表示する milestone グループ数の既定上限(AllDayBar の ALLDAY_MAX_VISIBLE_ROWS と同じ考え方) */
export const GITHUB_MAX_VISIBLE_MILESTONES = 3;

/**
 * [dayStartMs, dayEndMs) に収まる GitHubItem を抽出し、release とそれ以外(milestone/issue/PR)
 * に分けた上で、後者を milestone ごとにグルーピングし、表示する milestone グループ数を
 * maxVisibleGroups に制限する(超過分は overflowCount にまとめ、WeekGrid/GitHubLane 側は
 * 「+N」表示に使う)。milestone グループ単位で丸ごと出す/隠すため、1つの milestone の
 * issue/PR が中途半端に分断されることは無い。
 *
 * release(docs/github-integration.md フェーズ④「first cut」、2026-07-20)は milestone
 * グループとは独立に扱う: 1日あたりの想定件数がごく小さい(repo あたりせいぜい1件程度)ため、
 * v1 では上限・overflow 集計の対象にせず、応答順のまま全件 releases に入れる。
 */
export function layoutGitHubDay(
  items: GitHubItem[],
  dayStartMs: number,
  dayEndMs: number,
  maxVisibleGroups: number = GITHUB_MAX_VISIBLE_MILESTONES,
): GitHubDayLayout {
  const dayItems = items.filter((it) => it.dateMs >= dayStartMs && it.dateMs < dayEndMs);
  const releases = dayItems.filter((it) => it.type === "release");
  const groups = groupGitHubItemsByMilestone(dayItems);

  const visibleGroups = groups.slice(0, maxVisibleGroups);
  const hiddenGroups = groups.slice(maxVisibleGroups);
  const overflowCount = hiddenGroups.reduce(
    (sum, g) => sum + (g.milestone ? 1 : 0) + g.children.length,
    0,
  );

  return { visibleGroups, releases, overflowCount };
}
