/**
 * 設定モーダルの「テーマ」セクション (自動 / ライト / ダーク、2026-07-26) を担当するファイル。
 * 連携系のセクションと違って props に依存せず localStorage だけで完結する。
 */
import { useState } from "react";
import { getThemePref, setThemePref, type ThemePref } from "../../sync/themePref";

/** テーマ3択の表示ラベル。値の正は sync/themePref.ts の ThemePref */
const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
];

/**
 * テーマ3択 (自動 / ライト / ダーク、ユーザー要望、2026-07-26)。
 *
 * 保存ボタンは持たず、選んだ瞬間に setThemePref が localStorage への保存と
 * <html data-theme> の書き換えを両方行う ―― 配色の反映は theme.css (color-scheme +
 * light-dark()) が担うので、React 側に再描画すべきものは何も無い。
 *
 * したがって値の正は localStorage であり、ここの useState は「いま何にチェックが
 * 入っているか」を描くためだけのローカルな写し (GhPathOverrideControl と同じ流儀)。
 * App.tsx に state を持ち上げると二重管理になるだけで得が無いので持ち上げていない。
 *
 * ラジオグループにしたのは3択が排他だから ―― ネイティブの <input type="radio"> を
 * 同じ name で並べれば、矢印キーでの移動と読み上げ時の「n個中m番目・選択済み」が
 * ブラウザ標準で手に入る。
 */
export function ThemeSection() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());

  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title" id="settings-theme-title">
        テーマ
      </h3>
      <p className="settings-modal-section-desc">
        「自動」は、お使いの端末(OS)の外観設定に合わせて自動で切り替わります。
      </p>
      <div
        className="settings-modal-theme-options"
        role="radiogroup"
        aria-labelledby="settings-theme-title"
      >
        {THEME_OPTIONS.map((option) => (
          <label className="settings-modal-theme-option" key={option.value}>
            <input
              type="radio"
              name="settings-theme"
              value={option.value}
              checked={pref === option.value}
              onChange={() => {
                setThemePref(option.value);
                setPref(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
    </section>
  );
}
