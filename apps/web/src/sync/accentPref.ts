/**
 * アクセント色の設定(カラーテーマ、2026-11-07)。外観(ライト/ダーク。sync/themePref.ts)とは別の軸で、
 * <html> の data-accent 属性を出し入れするだけ。色の値は src/theme-accents.css(layout/accentPalette.ts から
 * 生成)が持ち、ここは色も分岐条件も持たない。既定の朱は「属性なし」(= theme.css の値のまま)。
 *
 * 初回描画前の適用は app/index.html の head インラインスクリプトが行う(FOUC 対策)。ここの規則を手で
 * 書き下したものなので、キーや許す値を変えたら両方を直すこと。
 */
import { ACCENT_KEYS, DEFAULT_ACCENT, type AccentKey } from "../layout/accentPalette";
import { readStored, removeStored, writeStored } from "../layout/localStore";

/**
 * 保存キー。テーマ設定(kichijitsu:theme)と同じく、ログアウトで消さない好みの設定なので、
 * sync/logoutLocalStorage.ts が除外として参照する。
 */
export const ACCENT_STORAGE_KEY = "kichijitsu:accent";

/** 保存値を AccentKey に正規化する。想定外の値は、すべて既定の朱に倒す(読めない値で画面を壊さない)。 */
export function normalizeAccentPref(raw: string | null | undefined): AccentKey {
  return (ACCENT_KEYS as readonly string[]).includes(raw ?? "") ? (raw as AccentKey) : DEFAULT_ACCENT;
}

/** 選択値 → <html> の data-accent 属性値。null は「属性を外す」(既定の朱)。 */
export function resolveAccentAttr(pref: AccentKey): string | null {
  return pref === DEFAULT_ACCENT ? null : pref;
}

export function getAccentPref(): AccentKey {
  return readStored(ACCENT_STORAGE_KEY, normalizeAccentPref, DEFAULT_ACCENT);
}

/** アクセント色を保存して、すぐ画面へ反映する(設定モーダルから呼ぶ)。既定の朱は保存値ごと消す。 */
export function setAccentPref(pref: AccentKey): void {
  if (pref === DEFAULT_ACCENT) removeStored(ACCENT_STORAGE_KEY);
  else writeStored(ACCENT_STORAGE_KEY, pref);
  const attr = resolveAccentAttr(pref);
  if (attr === null) document.documentElement.removeAttribute("data-accent");
  else document.documentElement.setAttribute("data-accent", attr);
}
