import { Appearance } from "react-native";
import { useSyncExternalStore } from "react";
import { getMeta, setMeta } from "./localDb";
import { ACCENTS, DEFAULT_ACCENT, type AccentKey, type AppearancePref } from "./accents";
import { writeWidgetTheme } from "./widgetSync";

/**
 * カラーテーマの設定(外観 + アクセント色)。端末の SQLite(meta)に保存し、変えると全画面が再描画される。
 * 外観は、OS 側の見た目を上書きする(Appearance.setColorScheme)ので、確認ダイアログ・キーボード・
 * 日時ピッカーも、アプリの外観に揃う。"system" は上書きを外して、OS に従う。
 */
export interface ThemePrefs {
  appearance: AppearancePref;
  accent: AccentKey;
}

const APPEARANCE_KEY = "themeAppearance";
const ACCENT_KEY = "themeAccent";

let prefs: ThemePrefs = { appearance: "system", accent: DEFAULT_ACCENT };
const listeners = new Set<() => void>();

function applyAppearance(a: AppearancePref) {
  Appearance.setColorScheme(a === "system" ? "unspecified" : a);
}

/** ウィジェットのアクセント色を合わせる。ウィジェットの失敗(未対応の環境など)で、設定の変更を止めない。 */
function pushWidgetTheme(accent: AccentKey) {
  try {
    writeWidgetTheme(accent);
  } catch {
    /* ウィジェットが無い環境 */
  }
}

function emit() {
  for (const l of listeners) l();
}

/** アプリの起動時に 1 回。保存された設定を読み戻して反映する(読めなければ既定のまま)。 */
export async function loadThemePrefs(): Promise<void> {
  try {
    const [a, c] = await Promise.all([getMeta(APPEARANCE_KEY), getMeta(ACCENT_KEY)]);
    const appearance: AppearancePref = a === "light" || a === "dark" ? a : "system";
    const accent: AccentKey = c !== null && c in ACCENTS ? (c as AccentKey) : DEFAULT_ACCENT;
    prefs = { appearance, accent };
    applyAppearance(appearance);
    emit();
    pushWidgetTheme(accent);
  } catch {
    /* 既定のまま */
  }
}

export function setThemePrefs(next: Partial<ThemePrefs>): void {
  prefs = { ...prefs, ...next };
  if (next.appearance !== undefined) applyAppearance(prefs.appearance);
  emit();
  if (next.appearance !== undefined) void setMeta(APPEARANCE_KEY, prefs.appearance).catch(() => undefined);
  if (next.accent !== undefined) {
    void setMeta(ACCENT_KEY, prefs.accent).catch(() => undefined);
    pushWidgetTheme(prefs.accent);
  }
}

export function useThemePrefs(): ThemePrefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => prefs,
  );
}
