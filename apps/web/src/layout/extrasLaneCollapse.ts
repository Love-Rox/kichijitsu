/**
 * 週表示の補助レーン(タスク + GitHub)を畳んでいるかどうかの表示設定 (2026-11-06)。
 *
 * 以前は GitHub レーンだけに畳む設定があり (layout/githubLaneCollapse.ts、2026-08-03)、
 * タスクレーンは常に開いていた。時間軸が始まる前に 終日/タスク/GitHub の3段で画面の約3割を
 * 使ってしまうため、**タスクと GitHub をひとつの「補助レーン」にまとめ、既定を畳む**ように変えた。
 * 畳んでいるときは、日ごとの件数だけを1行に出す (components/WeekGrid.tsx)。
 *
 * 保存形式: 既定が「畳む」なので、**展開しているときだけ "open" を保存**する
 * (既定へ戻すときは保存値ごと消す、githubLaneCollapse.ts と同じ流儀)。
 * 旧キー (kichijitsu:githubLaneCollapsed) は読まない ―― 意味が「GitHub だけ」で別物のため、
 * 引き継ぐと「タスクまで勝手に開く/畳む」ことになる。新しい既定から始める。
 *
 * localStorage に置くのは、端末ごとの見せ方だけの設定で、予定やアイテムの取捨選択には効かないため
 * (テーマや終日不在の置き場所と同じ側)。
 */
import { readStored, removeStored, writeStored, type StorageLike } from "./localStore";

/** 未設定 (初回) の既定値。畳む = 時間軸を広く見せる */
export const DEFAULT_EXTRAS_LANE_COLLAPSED = true;

const EXTRAS_LANE_STORAGE_KEY = "kichijitsu:extrasLaneCollapsed";

/** 保存値を boolean に正規化する。"open" だけを「展開」とみなし、それ以外は既定の畳むへ倒す */
export function normalizeExtrasLaneCollapsed(raw: string | null | undefined): boolean {
  return raw !== "open";
}

export function getExtrasLaneCollapsed(storage?: StorageLike): boolean {
  return readStored(
    EXTRAS_LANE_STORAGE_KEY,
    normalizeExtrasLaneCollapsed,
    DEFAULT_EXTRAS_LANE_COLLAPSED,
    storage,
  );
}

export function setExtrasLaneCollapsed(collapsed: boolean, storage?: StorageLike): void {
  if (collapsed === DEFAULT_EXTRAS_LANE_COLLAPSED) {
    removeStored(EXTRAS_LANE_STORAGE_KEY, storage);
  } else {
    writeStored(EXTRAS_LANE_STORAGE_KEY, "open", storage);
  }
}
