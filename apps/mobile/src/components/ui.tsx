import { StyleSheet, Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps } from "react-native";
import { useTheme } from "../theme";

/**
 * アプリ全体の文字の大きさの倍率。画面ごとに fontSize を直接書いているので、ここで 1 か所にまとめて拡大する
 * (一段階大きく = 約 1.15 倍)。lineHeight を指定している所も同じ倍率で広げる。
 */
export const FONT_SCALE = 1.15;
const DEFAULT_FONT_SIZE = 14; // React Native の既定

function scaled(style: TextProps["style"]) {
  const f = StyleSheet.flatten(style) ?? {};
  return {
    ...f,
    fontSize: Math.round((f.fontSize ?? DEFAULT_FONT_SIZE) * FONT_SCALE * 2) / 2,
    ...(f.lineHeight !== undefined ? { lineHeight: Math.round(f.lineHeight * FONT_SCALE * 2) / 2 } : null),
  };
}

/**
 * テーマに追従する Text / TextInput。React Native の Text は、色を指定しないと常に黒になる
 * (ダークモードで読めなくなる)ので、既定の色をテーマの文字色にする。個別の color は style で上書きできる。
 */
export function Text({ style, ...rest }: TextProps) {
  const t = useTheme();
  return <RNText {...rest} style={[{ color: t.ink }, scaled(style)]} />;
}

export function TextInput({ style, ...rest }: TextInputProps) {
  const t = useTheme();
  return (
    <RNTextInput
      placeholderTextColor={t.inkSub}
      selectionColor={t.accent}
      keyboardAppearance={t.scheme}
      {...rest}
      style={[{ color: t.ink }, scaled(style)]}
    />
  );
}
