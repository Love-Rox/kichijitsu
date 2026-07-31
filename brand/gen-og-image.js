// kichijitsu OG 画像生成 (apps/site/public/og.png の唯一の生成元 — PNG は手編集しない)
//
// リンクプレビュー (X / Slack / Discord / Facebook) に出る 1200x630 の画像。
// 構図はランディング (apps/site/index.html) のヒーローと同じ「枡の週 → 惹句 → ワードマーク」。
// プレビューは実寸の 3〜4 割まで縮小されて表示されるので、要素数を絞り
// 文字を大きく取っている (三行目の説明文などは入れない)。
//
// 色は brand/README.md のトークンのみを使う (新しい色を作らない)。
// ワードマークは brand/wordmark.svg をそのまま入れ子で埋め込み、`currentColor` だけを
// 墨に解決する ―― librsvg は currentColor を黒 (#000) にしてしまい、墨 (#24211E) にならないため。
//
// sharp はモノレポの pnpm 仮想ストアにのみ存在し (どの package.json にも依存として
// 宣言していない)、依存追加禁止の制約のため node_modules/.pnpm 配下を直接 require で
// 解決する (gen-pwa-icons.js と同じ理由・同じやり方。共通化するほどの分量ではないので複製)。
//
// **フォント依存**: 惹句と説明文は SVG の <text> なので、ラスタライズ時に OS の
// フォントを引く。macOS のヒラギノ (明朝 ProN W6 / 角ゴ ProN W6) を前提にしている
// (ランディングの --font-display = Zen Old Mincho は Web フォントで、ローカルには無いため
// 同系統の明朝で代替している)。別 OS で再生成すると字面が変わるので、
// 生成物の PNG をコミットして「再生成は原則 macOS で」という運用にしている。
//
// 再生成手順:
//   node gen-og-image.js   # 出力: ../apps/site/public/og.png
//   (pnpm --filter site gen:og でも可)
const fs = require("fs");
const path = require("path");

function resolveSharp() {
  try {
    // モノレポのどこかで sharp が通常解決できる場合はそれを使う
    return require("sharp");
  } catch {
    // 通常解決できない場合、pnpm 仮想ストアから直接探す
    const pnpmDir = path.join(__dirname, "..", "node_modules", ".pnpm");
    const entry = fs.readdirSync(pnpmDir).find((name) => name.startsWith("sharp@"));
    if (!entry) {
      throw new Error(
        "sharp が見つかりません。node_modules/.pnpm/sharp@* が存在するか確認してください。",
      );
    }
    return require(path.join(pnpmDir, entry, "node_modules", "sharp"));
  }
}

const sharp = resolveSharp();

const WORDMARK_SVG = path.join(__dirname, "wordmark.svg");
const OUT_FILE = path.join(__dirname, "..", "apps", "site", "public", "og.png");

// ブランドトークン (brand/README.md の表。ライト側の値)
const KINARI = "#FAF7F2"; // 生成り (背景)
const SUMI = "#24211E"; // 墨 (文字)
const USUZUMI = "#DCD6C9"; // 薄墨 (ふつうの日の枡)
const AKA = "#C13625"; // 朱 (吉日の枡)

// OGP の標準サイズ。X の summary_large_image (1.91:1) もこれで足りる
const W = 1200;
const H = 630;

// 枡の週: 7つ並べ、5番目だけ朱で -8° 傾ける (mark-week.svg と同じ並び)。
// 枡の比率は mark-week.svg 由来 ― 朱の枡は薄墨の 14/11 倍、角丸は辺の約 0.27。
const CELL = 56;
const CELL_GAP = 28;
const KICHI_SCALE = 14 / 11;
const STRIP_Y = 104;

// 文字。惹句はランディングの <h1> と同じで、説明文は og:description の一文目に揃えている。
const TAGLINE = "思い立ったが吉日。";
const TAGLINE_SIZE = 104;
const TAGLINE_BASELINE = 312;
const LEDE = "Google カレンダーを、あなたの手元に。";
const LEDE_SIZE = 44;
const LEDE_BASELINE = 400;

// ヒラギノを第一候補にした上で、無い環境でも「何も出ない」ことは避けるため総称名で締める。
const FONT_DISPLAY = "Hiragino Mincho ProN, Hiragino Mincho Pro, Yu Mincho, serif";
const FONT_BODY = "Hiragino Kaku Gothic ProN, Hiragino Sans, Noto Sans JP, sans-serif";

// ワードマーク。viewBox の縦横比 (423.29 : 111.13) を保った高さ指定で下部に置く。
const WORDMARK_H = 62;
const WORDMARK_W = Math.round((WORDMARK_H * 423.29) / 111.13);
const WORDMARK_Y = 476;

function masuStrip() {
  const total = CELL * 7 + CELL_GAP * 6;
  const x0 = (W - total) / 2;
  const cells = [];
  for (let i = 0; i < 7; i += 1) {
    const cx = x0 + i * (CELL + CELL_GAP) + CELL / 2;
    const cy = STRIP_Y + CELL / 2;
    if (i === 4) {
      // 吉日の枡。傾き -8° は「人の手が判を押した」の意味で、ブランド上の固定値
      const size = CELL * KICHI_SCALE;
      cells.push(
        `<rect x="${(cx - size / 2).toFixed(2)}" y="${(cy - size / 2).toFixed(2)}" ` +
          `width="${size.toFixed(2)}" height="${size.toFixed(2)}" rx="${(size * 0.25).toFixed(2)}" ` +
          `fill="${AKA}" transform="rotate(-8 ${cx.toFixed(2)} ${cy.toFixed(2)})"/>`,
      );
    } else {
      cells.push(
        `<rect x="${(cx - CELL / 2).toFixed(2)}" y="${STRIP_Y}" ` +
          `width="${CELL}" height="${CELL}" rx="${(CELL * 0.27).toFixed(2)}" fill="${USUZUMI}"/>`,
      );
    }
  }
  return cells.join("\n    ");
}

function wordmark() {
  const src = fs.readFileSync(WORDMARK_SVG, "utf8").trim();
  // 入れ子の <svg> は自前の viewBox を持つので、外側で位置と大きさだけ与えれば収まる。
  // currentColor は継承元が無く librsvg では黒になるため、ここで墨に固定する。
  const inner = src.replaceAll("currentColor", SUMI);
  const x = (W - WORDMARK_W) / 2;
  return `<svg x="${x}" y="${WORDMARK_Y}" width="${WORDMARK_W}" height="${WORDMARK_H}">${inner}</svg>`;
}

function buildSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${KINARI}"/>
    ${masuStrip()}
    <text x="${W / 2}" y="${TAGLINE_BASELINE}" text-anchor="middle" fill="${SUMI}"
      font-family="${FONT_DISPLAY}" font-weight="600" font-size="${TAGLINE_SIZE}">${TAGLINE}</text>
    <text x="${W / 2}" y="${LEDE_BASELINE}" text-anchor="middle" fill="${SUMI}"
      font-family="${FONT_BODY}" font-weight="400" font-size="${LEDE_SIZE}">${LEDE}</text>
    ${wordmark()}
  </svg>`;
}

async function main() {
  // density 144 = 2倍 (2400x1260) で描いてから等倍へ縮める。文字と傾いた枡の
  // アンチエイリアスが等倍レンダリングより滑らかになるため。
  const buf = await sharp(Buffer.from(buildSvg()), { density: 144 })
    .resize(W, H)
    .png()
    .toBuffer();
  await fs.promises.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.promises.writeFile(OUT_FILE, buf);
  console.log(`✓ ${path.relative(process.cwd(), OUT_FILE)} (${W}x${H})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
