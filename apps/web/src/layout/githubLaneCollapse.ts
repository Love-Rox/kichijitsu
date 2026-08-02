/**
 * GitHub レーン (components/GitHubLane.tsx) を畳んでいるかどうかの表示設定
 * (2026-08-03、ユーザー要望「GitHub の一覧が表示されるセクションが広くなって
 * 予定の表示が見れなくなる場合があります。折りたためるようにできますか?」)。
 *
 * なぜ localStorage か: 「この端末でレーンをどう見せるか」だけの設定で、予定やアイテムの
 * 取捨選択には一切効かない ―― 畳んでも GitHub アイテム自体は消えないし、同期にも影響しない。
 * 端末ごとに独立していてよい(狭い画面では畳み、広い画面では開く、が自然)ため、サーバー保存の
 * 「表示するカレンダー」ではなくテーマ (sync/themePref.ts) や終日不在の置き場所
 * (layout/oooAllDayPlacement.ts) と同じ側に置く。
 *
 * なぜ layout/ か: oooAllDayPlacement.ts と同じ理由。このリポジトリの依存の向きは
 * sync → layout の一方向で、layout から sync を import しているモジュールは1つも無い。
 * GitHub レーンの件数計算 (sync/mapGitHub.ts の countGitHubDayItems) とは独立した
 * 「保存された設定を読む/書く」だけの層なので、こちらへ置いても逆向きの矢印は生まれない。
 *
 * 保存形式は "1"(畳んでいる)のみ。既定(展開)は保存値ごと消す ―― setOooAllDayPlacement /
 * setThemePref("auto") と同じ流儀で、「未設定 = 現状維持」を明示的に書き残す理由が無い。
 */
import { readStored, removeStored, writeStored, type StorageLike } from "./localStore";

/**
 * 未設定 (初回) の既定値。現状維持のため false = 展開 ―― 既存利用者にとって
 * レーンが突然消えたように見えるのを避ける(DEFAULT_OOO_ALLDAY_PLACEMENT と同じ判断)。
 */
export const DEFAULT_GITHUB_LANE_COLLAPSED = false;

/** localStorage キー。他の設定 (kichijitsu:theme, kichijitsu:leftPaneOpen 等) と同じ名前空間 */
const GITHUB_LANE_COLLAPSED_STORAGE_KEY = "kichijitsu:githubLaneCollapsed";

/**
 * 保存値を boolean に正規化する。"1" だけを「畳んでいる」とみなし、それ以外
 * (未設定・"0"・過去バージョンや手書きのゴミ) はすべて既定の展開へ倒す。
 *
 * normalizeOooAllDayPlacement と同じ寛容さ ―― localStorage はユーザーが直接書き換えられる。
 * 「読めない値なら現状維持(展開)」の一点さえ守れば、どんな値が入っていてもレーンは壊れない。
 */
export function normalizeGitHubLaneCollapsed(raw: string | null | undefined): boolean {
  return raw === "1";
}

/** 保存された設定を読む(未設定・壊れた値・localStorage が使えない環境は既定の展開) */
export function getGitHubLaneCollapsed(storage?: StorageLike): boolean {
  return readStored(
    GITHUB_LANE_COLLAPSED_STORAGE_KEY,
    normalizeGitHubLaneCollapsed,
    DEFAULT_GITHUB_LANE_COLLAPSED,
    storage,
  );
}

/** 設定を保存する(レーン見出しのボタンから即座に呼ばれる。保存ボタンは持たせない) */
export function setGitHubLaneCollapsed(collapsed: boolean, storage?: StorageLike): void {
  if (collapsed === DEFAULT_GITHUB_LANE_COLLAPSED) {
    removeStored(GITHUB_LANE_COLLAPSED_STORAGE_KEY, storage);
  } else {
    writeStored(GITHUB_LANE_COLLAPSED_STORAGE_KEY, "1", storage);
  }
}
