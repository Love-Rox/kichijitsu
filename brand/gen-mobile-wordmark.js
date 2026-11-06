// kichijitsu モバイルアプリ用ワードマークの生成 (apps/mobile/src/assets/wordmarkSvg.ts の唯一の生成元)
//
// brand/wordmark.svg をそのまま文字列として埋め込む(React Native は SVG ファイルを直接 import できないため)。
// 変えるのは 1 点だけ: j の点の朱 (#C13625) を、実行時にテーマのアクセント色 (ダークでは #EA6451) へ差し替えられるよう、
// プレースホルダ __ACCENT__ にする。墨は currentColor のまま(描画側が color を渡す)。
// wordmark.svg は手編集禁止(brand/README.md)。変えたいときは gen-wordmark.js で再生成してから、これを実行する。
//
// 再生成手順:  node brand/gen-mobile-wordmark.js
const fs = require("fs");
const path = require("path");

const svg = fs.readFileSync(path.join(__dirname, "wordmark.svg"), "utf8");
if (!svg.includes('fill="#C13625"')) throw new Error('wordmark.svg に j の点の朱 (#C13625) が見つかりません');
const xml = svg.replace('fill="#C13625"', 'fill="__ACCENT__"');

const out = path.join(__dirname, "..", "apps", "mobile", "src", "assets", "wordmarkSvg.ts");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `// 生成物 — 手編集しない。元: brand/wordmark.svg、生成: node brand/gen-mobile-wordmark.js
// j の点の朱は __ACCENT__ に置き換えてある(components/Wordmark.tsx がテーマのアクセント色を入れる)。
export const WORDMARK_SVG = ${JSON.stringify(xml)};

/** viewBox の縦横比 (幅 / 高さ)。 */
export const WORDMARK_ASPECT = 423.29 / 111.13;
`,
);
console.log("✓ " + path.relative(process.cwd(), out));
