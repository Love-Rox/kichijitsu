// モバイルの UI アイコン(Phosphor duotone, MIT)から apps/mobile/src/assets/iconsData.ts を作る。
// 使い方: node brand/gen-icons.js <@phosphor-icons/core の展開先(package/ の親)>
//   例) npm pack @phosphor-icons/core@2.1.1 && tar xzf phosphor-icons-core-2.1.1.tgz && node <repo>/brand/gen-icons.js .
// アプリ内の名前 → Phosphor のアイコン名。足すときはここに 1 行足して再生成する。
const fs = require("node:fs");
const path = require("node:path");

const ICONS = {
  caretLeft: "caret-left",
  caretRight: "caret-right",
  search: "magnifying-glass",
  plus: "plus",
  more: "dots-three",
  gear: "gear",
  radioOff: "circle",
  radioOn: "check-circle",
  mapPin: "map-pin",
};

const root = process.argv[2];
if (!root) throw new Error("usage: node brand/gen-icons.js <phosphor core dir>");
const out = {};
for (const [name, file] of Object.entries(ICONS)) {
  const svg = fs.readFileSync(path.join(root, "package/assets/duotone", `${file}-duotone.svg`), "utf8");
  const layers = [...svg.matchAll(/<path d="([^"]+)"(?: opacity="([\d.]+)")?\/>/g)].map((m) =>
    m[2] ? { d: m[1], opacity: Number(m[2]) } : { d: m[1] },
  );
  if (layers.length < 1) throw new Error(`no paths: ${file}`);
  out[name] = layers;
}
const body =
  `// 生成物: node brand/gen-icons.js で作り直す。元は Phosphor Icons (duotone, MIT License, © 2023 Phosphor Icons)。\n` +
  `export interface IconLayer {\n  d: string;\n  /** 薄い面の層だけ付く(線の層は無し = 不透明) */\n  opacity?: number;\n}\n\n` +
  `export const ICON_VIEWBOX = "0 0 256 256";\n\n` +
  `export const ICONS = ${JSON.stringify(out, null, 2)} as const satisfies Record<string, readonly IconLayer[]>;\n\n` +
  `export type IconName = keyof typeof ICONS;\n`;
fs.writeFileSync(path.join(__dirname, "../apps/mobile/src/assets/iconsData.ts"), body);
console.log("wrote iconsData.ts:", Object.keys(out).join(", "));
