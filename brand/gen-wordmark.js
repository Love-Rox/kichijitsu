// kichijitsu ワードマーク生成 (wordmark.svg の唯一の生成元 — SVG は手編集しない)
// Inter SemiBold (SIL OFL 1.1, https://rsms.me/inter/) をアウトライン化し、
// i/j の点をすべて「枡」に置き換える:
//   ı ×3 → 正立した墨の枡 (currentColor)
//   ȷ ×1 → -8° 傾いた朱の枡 (#D7402E)
//
// 再生成手順:
//   npm i opentype.js
//   Inter-4.x.zip (github.com/rsms/inter/releases) から extras/otf/Inter-SemiBold.otf を取得
//   node gen-wordmark.js <Inter-SemiBold.otf のパス>   # 出力: ./wordmark.svg
const opentype = require('opentype.js');
const fs = require('fs');

const fontPath = process.argv[2] || 'Inter-SemiBold.otf';
const font = opentype.parse(fs.readFileSync(fontPath).buffer.slice(0));
const SIZE = 96;
const TRACKING = 0.015 * SIZE; // わずかな letter-spacing
const scale = SIZE / font.unitsPerEm;

const text = 'kıchıȷıtsu'; // dotless ı (U+0131) / dotless ȷ (U+0237)
// stringToGlyphs は Inter の GSUB (ccmp) で落ちるため文字単位で取得
const glyphs = [...text].map((ch) => font.charToGlyph(ch));

// レイアウト (カーニング込み)
let x = 0;
const baseY = 100;
const placed = [];
for (let i = 0; i < glyphs.length; i++) {
  const g = glyphs[i];
  placed.push({ g, x, i });
  x += g.advanceWidth * scale + TRACKING;
  if (i < glyphs.length - 1) {
    x += font.getKerningValue(g, glyphs[i + 1]) * scale;
  }
}

// 文字のパス連結 + 個別 bbox
let d = '';
const bboxes = [];
for (const p of placed) {
  const path = p.g.getPath(p.x, baseY, SIZE);
  d += path.toPathData(3);
  bboxes.push(path.getBoundingBox());
}

// ı の stem 幅と中心
const dotlessIdx = [1, 4, 6]; // ı
const jIdx = 5; // ȷ
const iStem = bboxes[1];
const stemW = iStem.x2 - iStem.x1;

// 点の中心高さ: 通常の 'i' の bbox 上端から点の半分だけ下
const iRef = font.charToGlyph('i').getPath(0, baseY, SIZE);
const iRefBB = iRef.getBoundingBox();
const dotCenterY = iRefBB.y1 + stemW / 2;

const sumiSide = stemW * 1.08;   // 墨の枡: 点とほぼ同寸
const akaSide = stemW * 1.35;    // 朱の枡: 一回り大きく (押印)
const rx = 0.22;

function rect(cx, cy, side, fill, rotate) {
  const x0 = (cx - side / 2).toFixed(2);
  const y0 = (cy - side / 2).toFixed(2);
  const r = (side * rx).toFixed(2);
  const rot = rotate ? ` transform="rotate(-8 ${cx.toFixed(2)} ${cy.toFixed(2)})"` : '';
  return `  <rect x="${x0}" y="${y0}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" rx="${r}" fill="${fill}"${rot}/>\n`;
}

let rects = '';
for (const idx of dotlessIdx) {
  const bb = bboxes[idx];
  rects += rect((bb.x1 + bb.x2) / 2, dotCenterY, sumiSide, 'currentColor', false);
}
{
  // ȷ は下のフックで bbox が広い → stem 上端付近の中心を使う:
  // stem は bbox の右端側にあるので、上端 y での水平中心を path から推定する
  // 簡便化: ȷ の bbox 右端 - stemW/2 を中心とみなす (Inter の ȷ は stem が右端)
  const bb = bboxes[jIdx];
  const cx = bb.x2 - stemW / 2;
  rects += rect(cx, dotCenterY, akaSide, '#D7402E', true);
}

// viewBox: 文字パス + 枡の外接
const union = bboxes.reduce(
  (a, b) => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) }),
  { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity },
);
const top = Math.min(union.y1, dotCenterY - akaSide); // 傾き余白込みでやや広めに
const bottom = union.y2;
const pad = 4;
const vb = `${(union.x1 - pad).toFixed(2)} ${(top - pad).toFixed(2)} ${(union.x2 - union.x1 + pad * 2).toFixed(2)} ${(bottom - top + pad * 2).toFixed(2)}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="kichijitsu">
  <!-- kichijitsu ワードマーク: Inter SemiBold (OFL) をアウトライン化。
       i の点 = 正立した墨の枡 (currentColor)、j の点 = -8° 傾いた朱の枡。
       生成スクリプト: scratchpad/gen-wordmark.js (座標は生成値、手編集しない) -->
  <path d="${d}" fill="currentColor"/>
${rects}</svg>
`;
fs.writeFileSync('wordmark.svg', svg);
console.log('stemW=', stemW.toFixed(2), 'dotCenterY=', dotCenterY.toFixed(2), 'viewBox=', vb);
