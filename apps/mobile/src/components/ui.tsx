import { Text as RNText, TextInput as RNTextInput, type TextInputProps, type TextProps } from "react-native";
import { useTheme } from "../theme";

/**
 * テーマに追従する Text / TextInput。React Native の Text は、色を指定しないと常に黒になる
 * (ダークモードで読めなくなる)ので、既定の色をテーマの文字色にする。個別の color は style で上書きできる。
 */
export function Text({ style, ...rest }: TextProps) {
  const t = useTheme();
  return <RNText {...rest} style={[{ color: t.ink }, style]} />;
}

export function TextInput({ style, ...rest }: TextInputProps) {
  const t = useTheme();
  return (
    <RNTextInput
      placeholderTextColor={t.inkSub}
      selectionColor={t.accent}
      keyboardAppearance={t.scheme}
      {...rest}
      style={[{ color: t.ink }, style]}
    />
  );
}
