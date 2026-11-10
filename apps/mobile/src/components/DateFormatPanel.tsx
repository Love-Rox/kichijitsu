import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import {
  DATE_FORMATS,
  DEFAULT_DATE_FORMAT,
  getWidgetDateFormat,
  saveWidgetDateFormat,
  type WidgetDateFormat,
} from "../lib/widgetDateFormat";
import { useTheme } from "../theme";
import { Icon } from "./Icon";
import { Text } from "./ui";

/** 設定シートの中の「日付の形式」の画面: ウィジェットの日付の見せ方を選ぶ。選ぶとすぐ保存され、ウィジェットに届く。 */
export function DateFormatPanel() {
  const t = useTheme();
  const [value, setValue] = useState<WidgetDateFormat>(DEFAULT_DATE_FORMAT);
  useEffect(() => {
    void getWidgetDateFormat().then(setValue);
  }, []);
  return (
    <View>
      <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>ウィジェットの日付</Text>
      {DATE_FORMATS.map((f) => {
        const selected = value === f.key;
        return (
          <Pressable
            key={f.key}
            onPress={() => {
              setValue(f.key);
              void saveWidgetDateFormat(f.key);
            }}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 }}
          >
            <Icon name={selected ? "radioOn" : "radioOff"} color={selected ? t.accent : t.inkSub} size={20} />
            <View style={{ flex: 1 }}>
              <Text>{f.label}</Text>
              <Text style={{ fontSize: 12, color: t.inkSub }}>{f.example}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
