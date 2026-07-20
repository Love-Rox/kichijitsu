import type { GitHubWorkItemDTO, GitHubWorkKind } from "@kichijitsu/shared";

/**
 * 作業キュー サイドレール(docs/github-integration.md フェーズ②Part B)の表示振り分けを担う
 * 純関数層(mapGitHub.ts と同じ考え方)。作業キューは IndexedDB に永続化せず React state で
 * 保持するだけ(日付を持たないライブな一覧のため)なので、ここには DTO→表示用の整形ロジックのみ置く。
 */

/** kind ごとのセクション見出し(GitHubPane.tsx が描画順に使う) */
export const WORK_QUEUE_SECTION_LABELS: Record<GitHubWorkKind, string> = {
  review_requested: "レビュー依頼",
  assigned: "自分の担当",
  authored: "自分の PR",
};

/** セクション表示順(review_requested → assigned → authored 固定) */
const SECTION_ORDER: GitHubWorkKind[] = ["review_requested", "assigned", "authored"];

export interface WorkQueueSection {
  kind: GitHubWorkKind;
  label: string;
  /** updatedAt 降順(新しい順)。1件が複数 kinds を持つ場合は該当する各セクションに重複して入る */
  items: GitHubWorkItemDTO[];
}

/**
 * GitHubWorkItemDTO[] を kind ごとのセクションへ振り分ける。1件が複数の kinds を持つ場合
 * (例: 自分が author かつ assignee)は該当する各セクションに重複して出す — dedupe しない。
 * 各セクション内は updatedAt の降順(ISO 8601 文字列なので辞書順比較で正しく並ぶ)。
 */
export function groupWorkItemsByKind(items: GitHubWorkItemDTO[]): WorkQueueSection[] {
  return SECTION_ORDER.map((kind) => ({
    kind,
    label: WORK_QUEUE_SECTION_LABELS[kind],
    items: items
      .filter((item) => item.kinds.includes(kind))
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
  }));
}
