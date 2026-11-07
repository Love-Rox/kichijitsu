import { Pressable, View } from "react-native";
import { ACCENT_KEYS, ACCENTS, APPEARANCES } from "../lib/accents";
import { setThemePrefs, useThemePrefs } from "../lib/themePrefs";
import { useTheme } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./ui";

/** 設定シートの中の「カラーテーマ」の画面: 外観(システム/ライト/ダーク)とアクセント色。選ぶとすぐ反映・保存される。 */
export function ThemePanel() {
  const t = useTheme();
  const prefs = useThemePrefs();
  return (
    <View>
      <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>外観</Text>
      {APPEARANCES.map((o) => {
        const selected = prefs.appearance === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => setThemePrefs({ appearance: o.key })}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 }}
          >
            <Icon name={selected ? "radioOn" : "radioOff"} color={selected ? t.accent : t.inkSub} size={20} />
            <Text>{o.label}</Text>
          </Pressable>
        );
      })}

      <Text style={{ fontSize: 13, color: t.inkSub, marginTop: 24, marginBottom: 10 }}>アクセント色</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {ACCENT_KEYS.map((k) => {
          const selected = prefs.accent === k;
          const color = ACCENTS[k][t.scheme].accent;
          return (
            <Pressable
              key={k}
              onPress={() => setThemePrefs({ accent: k })}
              accessibilityLabel={ACCENTS[k].label}
              style={{ alignItems: "center", width: 64 }}
            >
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: color,
                  alignItems: "center",
                  justifyContent: "center",
                  borderWidth: selected ? 3 : 0,
                  borderColor: t.ink,
                }}
              >
                {selected ? <Icon name="radioOn" color={t.onAccent} size={22} /> : null}
              </View>
              <Text style={{ fontSize: 12, color: selected ? t.ink : t.inkSub, marginTop: 4 }} numberOfLines={1}>
                {ACCENTS[k].label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* 見本: 今の外観・アクセント色での、ボタンと選択中の表示 */}
      <View style={{ marginTop: 28, padding: 14, borderRadius: 10, backgroundColor: t.surface, gap: 10 }}>
        <Text style={{ fontSize: 12, color: t.inkSub }}>見本</Text>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <View style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: t.accent }}>
            <Text style={{ color: t.onAccent, fontWeight: "700" }}>今日</Text>
          </View>
          <View style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: t.accentSoft }}>
            <Text style={{ color: t.accentStrong, fontWeight: "700" }}>選択中</Text>
          </View>
          <Text style={{ color: t.accent }}>リンク</Text>
        </View>
      </View>
      <Text style={{ marginTop: 14, fontSize: 12, color: t.inkSub }}>
        予定の色(カレンダーの色)は変わりません。ホーム画面のウィジェットには、アクセント色だけが反映されます(明るさは OS の設定に従います)。
      </Text>
    </View>
  );
}
