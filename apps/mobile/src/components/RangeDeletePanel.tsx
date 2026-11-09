import { Temporal } from "@js-temporal/polyfill";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { dayStartMs, plainDateOfMs } from "@kichijitsu/web/layout/dayTime";
import { MAX_RANGE_DELETE } from "@kichijitsu/web/sync/recurrenceDelete";
import { useTheme } from "../theme";
import { Text } from "./ui";

/**
 * 繰り返し予定の「この回から指定の日まで」を消す、日付の選択画面。予定の詳細シートの中身と入れ替えて出す
 * (iOS はモーダルを重ねて出せないことがあるため、別のシートにはしない)。
 * 最後の日は、その日を含む。消える回数を見せてから、削除する。
 */
export function RangeDeletePanel({
  title,
  firstMs,
  timeZone,
  count,
  onBack,
  onConfirm,
}: {
  title: string;
  /** 対象の回の開始(最後の日の下限) */
  firstMs: number;
  timeZone: string;
  /** 最後の日を渡すと、消える回数を返す(同期) */
  count: (until: string) => number;
  onBack: () => void;
  onConfirm: (until: string) => void;
}) {
  const t = useTheme();
  const firstDay = useMemo(() => plainDateOfMs(firstMs, timeZone), [firstMs, timeZone]);
  const [until, setUntil] = useState<Temporal.PlainDate>(firstDay);
  const untilStr = until.toString();
  const n = useMemo(() => count(untilStr), [count, untilStr]);

  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>{title}</Text>
      <Text style={{ marginTop: 6, color: t.inkMute }}>この予定から指定の日まで(その日を含む)を消します。</Text>
      <View style={{ marginTop: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 15 }}>最後の日</Text>
        <DateTimePicker
          themeVariant={t.scheme}
          accentColor={t.accent}
          mode="date"
          display="compact"
          locale="ja-JP"
          value={new Date(dayStartMs(until, timeZone))}
          minimumDate={new Date(dayStartMs(firstDay, timeZone))}
          onChange={(_, d) => {
            if (d) setUntil(plainDateOfMs(d.getTime(), timeZone));
          }}
        />
      </View>
      <Text style={{ marginTop: 12, fontSize: 13, color: t.inkMute }}>
        {n >= MAX_RANGE_DELETE
          ? `この予定から ${MAX_RANGE_DELETE} 回分(上限)を消します。それ以降は残るので、続きは期間を分けるか「すべての予定」を使ってください。`
          : `${n} 回分を消します(すでに消した回は数えません)。`}
      </Text>
      <View style={{ marginTop: 28, flexDirection: "row", gap: 28 }}>
        <Pressable onPress={() => onConfirm(untilStr)} disabled={n === 0}>
          <Text style={{ color: t.accent, fontSize: 15, opacity: n === 0 ? 0.4 : 1 }}>{n} 回分を削除</Text>
        </Pressable>
        <Pressable onPress={onBack}>
          <Text style={{ color: t.accent, fontSize: 15 }}>戻る</Text>
        </Pressable>
      </View>
    </View>
  );
}
