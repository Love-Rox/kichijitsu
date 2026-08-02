import type { GitHubItem } from "../model/types";
import type { GitHubMilestoneGroup } from "../sync/mapGitHub";
import { TagIcon } from "./icons";
import "./GitHubLane.css";

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
  // 中身が無い日でも器だけは必ず出す(2026-08-03)。親 (.week-grid-github-panel) は
  // grid-template-columns: repeat(dayCount, 1fr) の暗黙配置なので、**null を返すと
  // 以降の日が1列ずつ手前へ詰められて日付がずれる** ―― 実際、金曜だけ項目がある週で
  // 木曜の列に金曜のアイテムが描かれていた。空の器(高さ0)を置けば列が固定される。
  if (groups.length === 0 && releases.length === 0 && overflowCount === 0) {
    return <div className="github-lane-day" />;
  }

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

interface GitHubLaneCollapsedDayProps {
  /** その日の GitHub 項目の総数 (sync/mapGitHub.ts の countGitHubDayItems)。0 なら何も出さない */
  count: number;
  /** 見出し(ツールチップ)に使う日付表記。例 "8/5" */
  dateLabel: string;
}

/**
 * レーンを畳んでいるときの1日ぶんの列(2026-08-03、ユーザー要望「GitHub の一覧が表示される
 * セクションが広くなって予定の表示が見れなくなる」)。
 *
 * なぜ「完全に消す」ではなく件数を残すか: 畳んだレーンが空欄になると、**GitHub と連携して
 * いるのに何も無い状態**と見分けが付かなくなる。かといって全体で1つの合計数を出すだけでは
 * 「今日ぶんを見たいのか、週末ぶんなのか」が分からず、開くまで判断できない。展開時と同じ
 * 日ごとの列構造をそのまま使って**日ごとの件数だけを残す**と、1行(レーン全体で 22px 前後)で
 * 「どの日にどれだけあるか」が伝わり、目当ての日があるときだけ開けばよくなる
 * (計測: 週表示・標準ズームで展開 215px → 折りたたみ 22px)。
 *
 * GitHubLane 本体と同じく、項目が無い日でも空の器を返して列のずれを防ぐ(上記コメント参照)。
 * クリック可能な要素は置かない ―― 開閉の操作点はレーン見出し(week-grid-github-gutter)
 * ひとつに絞り、「どこを押せば開くか」を1箇所にする。
 */
export function GitHubLaneCollapsedDay({ count, dateLabel }: GitHubLaneCollapsedDayProps) {
  if (count === 0) return <div className="github-lane-day-collapsed" />;

  return (
    <div className="github-lane-day-collapsed">
      {/*
        単位「件」を DOM に出す(アイコンや装飾では代替しない)。数字だけのバッジは目では
        件数と読めても、読み上げでは「15」としか読まれず何の数か分からないため。
        日付は title(ツールチップ)側に添える ―― 列が日付と一対一に並ぶ画面で、
        バッジ本文にまで日付を書くと横幅を食うわりに情報が重複する。
      */}
      <span className="github-collapsed-count" title={`${dateLabel} GitHub ${count} 件`}>
        {count}
        <span className="github-collapsed-count-unit">件</span>
      </span>
    </div>
  );
}
