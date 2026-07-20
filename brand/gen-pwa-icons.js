// kichijitsu PWA アイコン生成 (apps/web/public/icons/*.png の唯一の生成元 — PNG は手編集しない)
// brand/tile.svg (96x96, 白背景タイル+枡グリッド+朱の押印) をラスタライズして
// 各サイズの PNG を書き出す。マスカブルアイコンと apple-touch-icon は
// 生成り (#FAF7F2) の背景キャンバスに合成する。
//
// sharp はモノレポの pnpm 仮想ストアにのみ存在し (apps/web / brand どちらの
// package.json にも依存として宣言していない)、依存追加禁止の制約のため
// node_modules/.pnpm 配下を直接 require で解決する。
//
// 再生成手順:
//   node gen-pwa-icons.js   # 出力: ../apps/web/public/icons/*.png
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

const TILE_SVG = path.join(__dirname, "tile.svg");
const OUT_DIR = path.join(__dirname, "..", "apps", "web", "public", "icons");
const KINARI = "#FAF7F2"; // ブランドトークン: 生成り (背景)

// tile.svg (viewBox 0 0 96 96) を size x size px でラスタライズする。
// density を出力サイズと一致させることで、SVG をそのサイズ向けに再描画させ
// (低解像度ラスタの拡大によるボケを避ける)、resize は端数丸めの保険。
async function renderTile(size) {
  return sharp(TILE_SVG, { density: size }).resize(size, size).png().toBuffer();
}

async function generatePlain(size, fileName) {
  const buf = await renderTile(size);
  await fs.promises.writeFile(path.join(OUT_DIR, fileName), buf);
  console.log(`✓ ${fileName} (${size}x${size})`);
}

// マスカブルアイコン: 512x512 の生成りキャンバスに tile.svg を約80%スケール
// (約410x410) で中央合成する。OS 側のマスク切り抜きに対するセーフゾーン確保。
async function generateMaskable() {
  const CANVAS = 512;
  const INNER = 410;
  const inner = await renderTile(INNER);
  const buf = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: KINARI },
  })
    .composite([{ input: inner, gravity: "center" }])
    .png()
    .toBuffer();
  await fs.promises.writeFile(path.join(OUT_DIR, "icon-maskable-512.png"), buf);
  console.log(`✓ icon-maskable-512.png (${CANVAS}x${CANVAS}, inner ${INNER}x${INNER})`);
}

// apple-touch-icon: iOS は透過を正しく扱わない/自動で角丸マスクを掛けるため、
// 生成りの不透明背景に tile.svg (フチ無し正方形) を合成してアルファを除去する。
async function generateAppleTouchIcon() {
  const SIZE = 180;
  const inner = await renderTile(SIZE);
  const buf = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: KINARI },
  })
    .composite([{ input: inner, gravity: "center" }])
    .flatten({ background: KINARI })
    .png()
    .toBuffer();
  await fs.promises.writeFile(path.join(OUT_DIR, "apple-touch-icon.png"), buf);
  console.log(`✓ apple-touch-icon.png (${SIZE}x${SIZE})`);
}

async function main() {
  await fs.promises.mkdir(OUT_DIR, { recursive: true });
  await generatePlain(192, "icon-192.png");
  await generatePlain(512, "icon-512.png");
  await generateMaskable();
  await generateAppleTouchIcon();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
