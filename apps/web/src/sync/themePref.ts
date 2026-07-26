/**
 * テーマ設定 (ダークモード切替、ユーザー要望、2026-07-26)。
 *
 * 配色そのものは src/theme.css が持つ ―― 全トークンが light-dark(ライト, ダーク) の1行で
 * 書かれていて、どちらが選ばれるかは :root に効いている color-scheme で決まる:
 *
 *   :root                         color-scheme: light dark  → OS の設定に従う
 *   :root[data-theme="light"]     color-scheme: light       → ライト固定
 *   :root[data-theme="dark"]      color-scheme: dark        → ダーク固定
 *
 * つまりこの層の仕事は「<html> の data-theme 属性を出し入れすること」だけで、
 * 色の値も分岐条件も一切持たない (theme.css の外に色リテラルを増やさない)。
 *
 * 初回描画前の適用は app/index.html の head インラインスクリプトが行う (FOUC 対策)。
 * ここの純関数と同じ規則を手で書き下したものなので、片方を変えたら両方を直すこと ――
 * その旨は index.html 側にもコメントで書いてある。
 */
import { readStored, removeStored, writeStored } from "../layout/localStore";

/** テーマ設定の3択。既定は "auto" (OS の設定に従う) */
export type ThemePref = "auto" | "light" | "dark";

/**
 * テーマ設定の localStorage キー。他の設定 (kichijitsu:view, kichijitsu:ghPath 等) と
 * 同じ `kichijitsu:` 名前空間に揃える。
 */
const THEME_STORAGE_KEY = "kichijitsu:theme";

/**
 * 保存値を ThemePref に正規化する。想定外の値はすべて既定の "auto" に倒す。
 *
 * なぜ寛容にするか: localStorage はユーザーが直接書き換えられるうえ、将来 "system" のような
 * 別名に変えたり選択肢を減らしたりすると、古いバージョンが書いた値が残る。
 * 「読めない値なら OS 連動に戻る」という一点だけを守れば、どんなゴミが入っていても
 * 画面が壊れない (アプリの見た目が真っ黒/真っ白で固まる、といった事故を防ぐ)。
 */
export function normalizeThemePref(raw: string | null | undefined): ThemePref {
  return raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto";
}

/**
 * 選択値 → <html> に付ける data-theme 属性値。null は「属性を外す」の意味。
 *
 * "auto" で属性値を書かず**外す**のが要点: theme.css の既定 (:root の
 * color-scheme: light dark) にそのまま戻すことで OS 連動が復活する。
 * data-theme="auto" のような値を書いてしまうと、CSS 側に対応する規則が無いぶんは
 * 同じ結果になるものの、「属性が付いている = 明示指定されている」という
 * theme.css 側の読み方と食い違うので採らない。
 */
export function resolveThemeAttr(pref: ThemePref): string | null {
  return pref === "auto" ? null : pref;
}

/**
 * 選択値 → <meta name="theme-color"> 2枚それぞれに設定する media 属性値
 * (app/index.html の data-scheme="light" / "dark" が付いた meta に対応する)。
 *
 * theme-color は PWA / モバイルブラウザのアドレスバー・ステータスバーの色で、CSS 変数は
 * 届かない (色は HTML 側に直書きするしかない)。ならば切り替えも「どちらの meta を
 * 有効にするか」で表現するのが自然:
 *
 *   auto        … prefers-color-scheme をそのまま書いてブラウザに OS 追従させる
 *                 (JS で OS の変化を監視しなくても追従する ―― 監視の二重管理を避けられる)
 *   light/dark  … 選ばれた側を "all" (常に一致)、もう片方を "not all" (決して一致しない)
 *                 にして、OS の設定を無視させる
 *
 * こうしないと「OS ダーク + 設定ライト」でページだけ白くアドレスバーは黒、という
 * ちぐはぐな見た目になる。
 */
export function resolveThemeColorMedia(pref: ThemePref): { light: string; dark: string } {
  if (pref === "light") return { light: "all", dark: "not all" };
  if (pref === "dark") return { light: "not all", dark: "all" };
  return { light: "(prefers-color-scheme: light)", dark: "(prefers-color-scheme: dark)" };
}

/**
 * 保存されたテーマ設定を読む (未設定・壊れた値・localStorage が使えない環境は "auto")。
 * try/catch の定型は layout/localStore.ts に寄せてある。
 */
export function getThemePref(): ThemePref {
  return readStored(THEME_STORAGE_KEY, normalizeThemePref, "auto");
}

/**
 * テーマ設定を保存して即座に画面へ反映する (設定モーダルの3択から呼ぶ)。
 * "auto" は保存値ごと消す ―― 「未設定 = OS 連動」と同じ状態に戻すのが素直で、
 * 既定値を明示的に書き残しておく理由が無い (setGhPathOverride が空文字で削除するのと同じ流儀)。
 */
export function setThemePref(pref: ThemePref): void {
  if (pref === "auto") removeStored(THEME_STORAGE_KEY);
  else writeStored(THEME_STORAGE_KEY, pref);
  applyThemePref(pref);
}

/**
 * テーマ設定を DOM に適用する薄い配線 (data-theme 属性 + theme-color meta)。
 * 判断は上の純関数が全部済ませているので、ここは属性を書くだけ。
 */
export function applyThemePref(pref: ThemePref): void {
  const attr = resolveThemeAttr(pref);
  if (attr === null) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", attr);

  const media = resolveThemeColorMedia(pref);
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"][data-scheme]',
  )) {
    meta.media = meta.dataset.scheme === "dark" ? media.dark : media.light;
  }
}
