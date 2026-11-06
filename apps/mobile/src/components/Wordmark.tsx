import { SvgXml } from "react-native-svg";
import { WORDMARK_ASPECT, WORDMARK_SVG } from "../assets/wordmarkSvg";
import { useTheme } from "../theme";

/**
 * kichijitsu のロゴタイプ (brand/wordmark.svg)。墨は文字色、j の点は朱(ダークでは明るい朱)で、
 * テーマに追従する。タイトルは、文字ではなく、これを使う。
 */
export function Wordmark({ height = 22 }: { height?: number }) {
  const t = useTheme();
  return (
    <SvgXml
      xml={WORDMARK_SVG.replace("__ACCENT__", t.accent)}
      width={height * WORDMARK_ASPECT}
      height={height}
      color={t.ink}
      accessibilityLabel="kichijitsu"
    />
  );
}
