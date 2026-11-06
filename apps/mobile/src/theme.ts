import { useColorScheme } from "react-native";

/**
 * デスクトップ(Web)版のカラーパレット (apps/web/src/theme.css の `--c-*` トークン) を、そのまま移したもの。
 * 値は light-dark(ライト, ダーク) の対応を、同じ名前の light / dark に置いてある。
 * 色を変えるときは theme.css 側を正とし、ここを追従させる。
 * 予定カードの色の混ぜ方も Web と同じ: color-mix(カレンダー色 tint%, 下地) を JS で計算する。
 */
const light = {
  bg: "#faf7f2",
  surface: "#ffffff",
  surface2: "#f0ece3",
  ink: "#24211e",
  inkMute: "#55504a",
  inkSub: "#8a8478",
  inkFaint: "#cfc8ba",
  line: "#e5e7eb",
  lineWarm: "#f0ece3",
  lineFaint: "#f7f4ee",
  accent: "#c13625",
  accentStrong: "#9d2b1b",
  accentSoft: "#f6e3dc",
  onAccent: "#faf7f2",
  success: "#0b8043",
  danger: "#ef4444",
  uiInkStrong: "#1f2937",
  uiInkMute: "#6b7280",
  uiInkFaint: "#9ca3af",
  busyFallback: "#c9c2b4",
  hoverTint: "#2563eb",
  /** 予定カードの地: カレンダー色を下地(surface)へ混ぜる割合(%)。時刻予定 / 終日 / 月のチップ */
  tintEvent: 15,
  tintAllDay: 18,
  tintChip: 16,
  /** 今日の列に敷く色の濃さ(%) */
  tintToday: 4,
};

const dark: typeof light = {
  bg: "#201f25",
  surface: "#17161a",
  surface2: "#26242c",
  ink: "#f5f1e9",
  inkMute: "#b3aca3",
  inkSub: "#928c85",
  inkFaint: "#585450",
  line: "#35323c",
  lineWarm: "#2e2b35",
  lineFaint: "#29262f",
  accent: "#ea6451",
  accentStrong: "#ff7c66",
  accentSoft: "#3e2320",
  onAccent: "#17161a",
  success: "#2e9e5a",
  danger: "#f87171",
  uiInkStrong: "#dbdbe2",
  uiInkMute: "#87878b",
  uiInkFaint: "#5a5a5d",
  busyFallback: "#6b6660",
  hoverTint: "#c7d9ff",
  tintEvent: 24,
  tintAllDay: 28,
  tintChip: 26,
  tintToday: 4,
};

export type Theme = typeof light & {
  scheme: "light" | "dark";
  /** カレンダー色を下地へ混ぜた、予定カードの地の色 */
  eventBg: (color: string) => string;
  allDayBg: (color: string) => string;
  chipBg: (color: string) => string;
  /** 今日の列の地(hoverTint を薄く敷く) */
  todayBg: string;
};

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** CSS の color-mix(in srgb, a pct%, b) と同じ: a を pct%、b を残りで混ぜる。 */
export function mix(a: string, b: string, pct: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return b;
  const t = pct / 100;
  const ch = (i: number) => Math.round(ca[i] * t + cb[i] * (1 - t));
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function build(scheme: "light" | "dark"): Theme {
  const p = scheme === "dark" ? dark : light;
  return {
    ...p,
    scheme,
    eventBg: (color) => mix(color, p.surface, p.tintEvent),
    allDayBg: (color) => mix(color, p.surface, p.tintAllDay),
    chipBg: (color) => mix(color, p.surface, p.tintChip),
    todayBg: mix(p.hoverTint, p.bg, p.tintToday),
  };
}

const themes = { light: build("light"), dark: build("dark") };

/** OS のライト/ダークに追従したパレット。 */
export function useTheme(): Theme {
  return useColorScheme() === "dark" ? themes.dark : themes.light;
}
