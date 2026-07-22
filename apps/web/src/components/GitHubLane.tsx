import type { GitHubItem } from "../model/types";
import type { GitHubMilestoneGroup } from "../sync/mapGitHub";
import { TagIcon } from "./icons";

interface GitHubLaneProps {
  /** その日ぶんの milestone グループ(表示上限適用済み、sync/mapGitHub.ts の layoutGitHubDay 参照) */
  groups: GitHubMilestoneGroup[];
  /** その日ぶんの release 項目(milestone グループに属さない独立アイテム、上限なし) */
  releases: GitHubItem[];
  /** 上限を超えて非表示になった項目数。0 なら「+N」を出さない */
  overflowCount: number;
}

/**
 * GitHub 専用レーン(docs/github-integration.md フェーズ①Part B、release はフェーズ④
 * 「first cut」、2026-07-20)の1日ぶんの列。WeekGrid.tsx の週/day3/day1 タイムラインで、
 * 終日レーンの直下に独立した行として並ぶ。
 *
 * AllDayBar/TaskRow と違いドラッグ・詳細ポップオーバーは対象外(表示専用)。milestone は
 * 見出し的マーカー(◆ + タイトル + repo)、issue/PR はその下に小さなチップとして並べる。
 * release は milestone グループに属さない独立の一覧として、milestone グループより前に
 * 表示する(「先に出た成果物」を視覚的に先頭に置く)。クリックは <a target="_blank"> で
 * GitHub 側の画面をそのまま新規タブで開く(キーボード操作・右クリックでのタブ複製など、
 * ネイティブリンクの挙動をそのまま活かすため onClick+window.open ではなくこちらを使う)。
 */
export function GitHubLane({ groups, releases, overflowCount }: GitHubLaneProps) {
  if (groups.length === 0 && releases.length === 0 && overflowCount === 0) return null;

  return (
    <div className="github-lane-day">
      {releases.length > 0 && (
        <div className="github-release-list">
          {releases.map((release) => (
            <a
              key={release.id}
              className="github-release-marker"
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${release.repo} release ${release.title}`}
            >
              <span className="github-release-tag" aria-hidden="true">
                <TagIcon width={11} height={11} />
              </span>
              <span className="github-release-title">{release.title}</span>
              <span className="github-release-repo">{release.repo}</span>
            </a>
          ))}
        </div>
      )}
      {groups.map((group) => (
        <div className="github-milestone-group" key={group.key}>
          {group.milestone && (
            <a
              className="github-milestone-marker"
              href={group.milestone.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${group.repo} milestone #${group.milestone.number} ${group.milestoneTitle}`}
            >
              <span className="github-milestone-diamond" aria-hidden="true">
                ◆
              </span>
              <span className="github-milestone-title">{group.milestoneTitle}</span>
              <span className="github-milestone-repo">{group.repo}</span>
            </a>
          )}
          {group.children.length > 0 && (
            <div className="github-item-chips">
              {group.children.map((item) => (
                <a
                  key={item.id}
                  className={`github-item-chip github-item-chip--${item.type}`}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${item.repo} #${item.number} ${item.title}`}
                >
                  <span className="github-item-chip-kind" aria-hidden="true">
                    {item.type === "pr" ? "PR" : "Iss"}
                  </span>
                  <span className="github-item-chip-text">
                    #{item.number} {item.title}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
      {overflowCount > 0 && (
        <div className="github-overflow" title={`他 ${overflowCount} 件`}>
          +{overflowCount}
        </div>
      )}
    </div>
  );
}
