// Web 版のアクセント色の CSS(apps/web/src/theme-accents.css)を、共通のパレット表から作る。
// 使い方: node brand/gen-web-accents.mjs   (Node の型除去で .ts を直接読む。表を直したら必ず走らせ直す)
// <html data-accent="indigo"> のときだけ、theme.css のアクセント系トークンを差し替える(既定の朱は属性なし)。
// ライト/ダークは light-dark() で切り替わる。--c-accent-rgb(半透明用)だけは、light-dark() に載せられないので、
// theme.css と同じく 3 か所(ライト・OS ダーク・data-theme=dark)に分けて書く。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCENTS, DEFAULT_ACCENT } from "../apps/web/src/layout/accentPalette.ts";

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** a を pct%、b を残りで混ぜる(CSS の color-mix(in srgb) と同じ) */
const mix = (a, b, pct) => {
  const ca = hex(a), cb = hex(b);
  return toHex(ca.map((v, i) => v * (pct / 100) + cb[i] * (1 - pct / 100)));
};
const rgb = (h) => hex(h).join(", ");

// theme.css の朱の値から逆算した割合(--c-accent-soft-line は soft と accent の間、--c-accent-ink は
// ライトでは strong を黒へ、ダークでは accent を白へ寄せた色)
const derive = (scheme, c) =>
  scheme === "light"
    ? { ink: mix(c.accentStrong, "#000000", 80), softLine: mix(c.accent, c.accentSoft, 12) }
    : { ink: mix("#ffffff", c.accent, 45), softLine: mix(c.accent, c.accentSoft, 20) };

const out = [
  "/* 生成物: node brand/gen-web-accents.mjs で作り直す(元の表は src/layout/accentPalette.ts)。手で直さない。 */",
  "",
];
for (const [key, def] of Object.entries(ACCENTS)) {
  if (key === DEFAULT_ACCENT) continue; // 既定の朱は theme.css の値のまま
  const l = { ...def.light, ...derive("light", def.light) };
  const d = { ...def.dark, ...derive("dark", def.dark) };
  const pair = (a, b) => `light-dark(${a}, ${b})`;
  out.push(
    `:root[data-accent="${key}"] {`,
    `  --c-accent: ${pair(l.accent, d.accent)};`,
    `  --c-accent-strong: ${pair(l.accentStrong, d.accentStrong)};`,
    `  --c-accent-ink: ${pair(l.ink, d.ink)};`,
    `  --c-accent-soft: ${pair(l.accentSoft, d.accentSoft)};`,
    `  --c-accent-soft-line: ${pair(l.softLine, d.softLine)};`,
    `  --c-accent-rgb: ${rgb(l.accent)};`,
    `}`,
    `@media (prefers-color-scheme: dark) {`,
    `  :root[data-accent="${key}"]:not([data-theme="light"]) {`,
    `    --c-accent-rgb: ${rgb(d.accent)};`,
    `  }`,
    `}`,
    `:root[data-accent="${key}"][data-theme="dark"] {`,
    `  --c-accent-rgb: ${rgb(d.accent)};`,
    `}`,
    "",
  );
}
writeFileSync(fileURLToPath(new URL("../apps/web/src/theme-accents.css", import.meta.url)), out.join("\n"));
console.log("wrote theme-accents.css");
