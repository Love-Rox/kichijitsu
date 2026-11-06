// kichijitsu iOS アプリアイコン生成 (apps/mobile/assets/icon.png の唯一の生成元 — PNG は手編集しない)
//
// iOS のアイコンは 1024x1024 の正方形で、**透明部分も角丸も持たない** (OS が角丸に切り抜く)。
// brand/tile.svg の「白タイル + 角丸の枠」は使わず、生成り (#FAF7F2) の全面の下地に、
// 同じ「枡の週」(月グリッド 3x2、下段中央だけ朱で -8° 傾けた押印) を中央へ大きめに置く。
// 枡の形・色・傾きは tile.svg と同じ値 (ブランドトークンは brand/README.md)。
//
// sharp は gen-pwa-icons.js と同じ方法で解決する (依存追加禁止のため pnpm 仮想ストアを直接探す)。
//
// 再生成手順:
//   node gen-ios-icon.js   # 出力: ../apps/mobile/assets/icon.png
const fs = require("fs");
const path = require("path");

function resolveSharp() {
  try {
    return require("sharp");
  } catch {
    const pnpmDir = path.join(__dirname, "..", "node_modules", ".pnpm");
    const entry = fs.readdirSync(pnpmDir).find((name) => name.startsWith("sharp@"));
    if (!entry) throw new Error("sharp が見つかりません。node_modules/.pnpm/sharp@* を確認してください。");
    return require(path.join(pnpmDir, entry, "node_modules", "sharp"));
  }
}
const sharp = resolveSharp();

const KINARI = "#FAF7F2"; // 生成り (背景)
const SIZE = 1024;
// 枡グリッドの中心 (tile.svg の座標系で x 20..77, y 26..72 → 中心 48.5, 49) を、キャンバス中央へ
// 倍率 SCALE で置く。大きすぎると OS の角丸切り抜きで枡が欠けるので、余白を残す。
const SCALE = 1.25;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 96 96">
  <rect width="96" height="96" fill="${KINARI}"/>
  <g transform="translate(48 48) scale(${SCALE}) translate(-48.5 -49)">
    <g fill="#DCD6C9">
      <rect x="20" y="26" width="15" height="15" rx="4"/>
      <rect x="41" y="26" width="15" height="15" rx="4"/>
      <rect x="62" y="26" width="15" height="15" rx="4"/>
      <rect x="20" y="55" width="15" height="15" rx="4"/>
      <rect x="62" y="55" width="15" height="15" rx="4"/>
    </g>
    <rect x="39" y="53" width="19" height="19" rx="5" fill="#C13625" transform="rotate(-8 48.5 62.5)"/>
  </g>
</svg>`;

async function main() {
  const out = path.join(__dirname, "..", "apps", "mobile", "assets", "icon.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // flatten + removeAlpha: App Store Connect は、アルファチャンネルを持つアイコンを拒否する
  const buf = await sharp(Buffer.from(svg), { density: 384 })
    .resize(SIZE, SIZE)
    .flatten({ background: KINARI })
    .removeAlpha()
    .png()
    .toBuffer();
  await fs.promises.writeFile(out, buf);
  console.log(`✓ ${path.relative(process.cwd(), out)} (${SIZE}x${SIZE})`);
}
main();
