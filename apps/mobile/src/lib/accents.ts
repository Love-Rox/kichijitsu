/**
 * アクセント色の候補。ライト/ダークそれぞれで、アクセント・濃いアクセント・淡い地の 3 色を持つ
 * (予定カードの色や、文字・背景の色は変えない)。既定の "kichijitsu" は、デスクトップ版と同じ朱色。
 */
export interface AccentColors {
  accent: string;
  accentStrong: string;
  accentSoft: string;
}

export interface AccentDef {
  label: string;
  light: AccentColors;
  dark: AccentColors;
}

export const ACCENTS = {
  kichijitsu: {
    label: "朱(既定)",
    light: { accent: "#c13625", accentStrong: "#9d2b1b", accentSoft: "#f6e3dc" },
    dark: { accent: "#ea6451", accentStrong: "#ff7c66", accentSoft: "#3e2320" },
  },
  indigo: {
    label: "藍",
    light: { accent: "#3f5fc4", accentStrong: "#2f4aa0", accentSoft: "#e1e7f8" },
    dark: { accent: "#7b97ee", accentStrong: "#9bb2ff", accentSoft: "#232a45" },
  },
  green: {
    label: "緑",
    light: { accent: "#2f8f5b", accentStrong: "#226e44", accentSoft: "#dff0e6" },
    dark: { accent: "#4fc183", accentStrong: "#72dba0", accentSoft: "#1f3a2b" },
  },
  purple: {
    label: "紫",
    light: { accent: "#8a4fc4", accentStrong: "#6c3aa0", accentSoft: "#ece1f7" },
    dark: { accent: "#b58aee", accentStrong: "#cba8ff", accentSoft: "#33264a" },
  },
  orange: {
    label: "橙",
    light: { accent: "#d9731a", accentStrong: "#b05a10", accentSoft: "#f9e6d3" },
    dark: { accent: "#f0954a", accentStrong: "#ffb06b", accentSoft: "#3f2c1a" },
  },
  sumi: {
    label: "墨",
    light: { accent: "#4a4a52", accentStrong: "#2f2f35", accentSoft: "#e8e8ec" },
    dark: { accent: "#c4c4cc", accentStrong: "#e0e0e6", accentSoft: "#34343a" },
  },
} as const satisfies Record<string, AccentDef>;

export type AccentKey = keyof typeof ACCENTS;
export const DEFAULT_ACCENT: AccentKey = "kichijitsu";
export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

/** 外観: システムに従う / ライト / ダーク */
export type AppearancePref = "system" | "light" | "dark";
export const APPEARANCES: { key: AppearancePref; label: string }[] = [
  { key: "system", label: "システムに従う" },
  { key: "light", label: "ライト" },
  { key: "dark", label: "ダーク" },
];
