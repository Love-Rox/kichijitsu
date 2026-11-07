// Web 版の UI アイコン(Phosphor duotone, MIT)から apps/web/src/components/iconPaths.ts を作る。
// 使い方: npm pack @phosphor-icons/core@2.1.1 && tar xzf phosphor-icons-core-2.1.1.tgz
//         node <repo>/brand/gen-web-icons.mjs <展開先(package/ の親)>
// アプリ内の名前 → Phosphor のアイコン名。足すときは、ここに 1 行足して作り直す。
// (Slack・Meet・Zoom・Teams のブランドマークは、Phosphor ではなく icons.tsx に手書きで残してある)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS = {
  pin: "push-pin",
  panel: "picture-in-picture",
  calendar: "calendar-blank",
  gear: "gear",
  more: "dots-three",
  timer: "timer",
  tag: "tag",
  search: "magnifying-glass",
  zoomOut: "magnifying-glass-minus",
  zoomIn: "magnifying-glass-plus",
  video: "video-camera",
  place: "map-pin",
};

const root = process.argv[2];
if (!root) throw new Error("usage: node brand/gen-web-icons.mjs <phosphor core dir>");
const out = {};
for (const [name, file] of Object.entries(ICONS)) {
  const svg = readFileSync(join(root, "package/assets/duotone", `${file}-duotone.svg`), "utf8");
  const layers = [...svg.matchAll(/<path d="([^"]+)"(?: opacity="([\d.]+)")?\/>/g)].map((m) =>
    m[2] ? { d: m[1], opacity: Number(m[2]) } : { d: m[1] },
  );
  if (layers.length < 1) throw new Error(`no paths: ${file}`);
  out[name] = layers;
}
const body =
  `// 生成物: node brand/gen-web-icons.mjs で作り直す。元は Phosphor Icons (duotone, MIT License, © 2023 Phosphor Icons)。\n` +
  `export interface IconLayer {\n  d: string;\n  /** 薄い面の層だけ付く(線の層は無し = 不透明) */\n  opacity?: number;\n}\n\n` +
  `export const ICON_VIEWBOX = "0 0 256 256";\n\n` +
  `export const ICON_PATHS = ${JSON.stringify(out, null, 2)} as const satisfies Record<string, readonly IconLayer[]>;\n\n` +
  `export type IconPathName = keyof typeof ICON_PATHS;\n`;
writeFileSync(fileURLToPath(new URL("../apps/web/src/components/iconPaths.ts", import.meta.url)), body);
console.log("wrote iconPaths.ts:", Object.keys(out).join(", "));
