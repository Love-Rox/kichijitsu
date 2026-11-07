import Svg, { Path } from "react-native-svg";
import { ICONS, ICON_VIEWBOX, type IconName } from "../assets/iconsData";

/**
 * UI のアイコン(Phosphor duotone。m-ai-log と同じ系統)。薄い面 + 線を、同じ色で重ねて描く。
 * 絵文字や記号(‹ › ＋ 🔍 ⋯ ● ○)は、端末のフォントで見た目が変わるので使わない。
 */
export function Icon({ name, color, size = 22 }: { name: IconName; color: string; size?: number }) {
  return (
    <Svg viewBox={ICON_VIEWBOX} width={size} height={size} accessibilityElementsHidden importantForAccessibility="no">
      {ICONS[name].map((l, i) => (
        <Path key={i} d={l.d} fill={color} fillOpacity={"opacity" in l ? l.opacity : undefined} />
      ))}
    </Svg>
  );
}
