import "../lib/polyfills";
import { Stack } from "expo-router";
import { useTheme } from "../theme";
import { installNotificationHandler } from "../lib/notifications";
import { loadThemePrefs } from "../lib/themePrefs";
import { useEffect } from "react";

installNotificationHandler();

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    void loadThemePrefs();
  }, []);
  // 画面の背景は、デスクトップ版と同じ --c-bg(下地の和紙色)。ダークも追従する
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />;
}
