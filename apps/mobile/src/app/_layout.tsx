import "../lib/polyfills";
import { Stack } from "expo-router";
import { useTheme } from "../theme";

export default function RootLayout() {
  const t = useTheme();
  // 画面の背景は、デスクトップ版と同じ --c-bg(下地の和紙色)。ダークも追従する
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />;
}
