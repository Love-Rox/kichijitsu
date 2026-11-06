import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import type { CalendarData } from "../lib/calendarData";
import { formatDay, formatTime } from "../lib/format";
import { isTimed, type EventSubject } from "../lib/mutations";
import { searchEvents } from "../lib/search";
import { useTheme } from "../theme";
import { Text, TextInput } from "./ui";

/** 予定の検索(下から出るシート)。結果をタップすると、その予定の詳細を開く。 */
export function SearchSheet({
  visible,
  data,
  timeZone,
  onClose,
  onSelect,
}: {
  visible: boolean;
  data: CalendarData;
  timeZone: string;
  onClose: () => void;
  onSelect: (subject: EventSubject) => void;
}) {
  const t = useTheme();
  const [text, setText] = useState("");
  // 入力のたびに探さず、少し止まってから探す(予定が多くても、入力が重くならないように)
  const [query, setQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQuery(text), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => {
    if (!visible) {
      setText("");
      setQuery("");
    }
  }, [visible]);

  const hits = useMemo(
    () => (visible ? searchEvents(data, query, Date.now(), timeZone) : []),
    [visible, data, query, timeZone],
  );
  const upcoming = hits.filter((h) => h.upcoming);
  const past = hits.filter((h) => !h.upcoming);

  const row = (h: (typeof hits)[number]) => {
    const s = h.subject;
    const when = isTimed(s)
      ? `${formatDay(s.startMs, timeZone)} ${formatTime(s.startMs, timeZone)}–${formatTime(s.endMs, timeZone)}`
      : (() => {
          const d = Temporal.PlainDate.from(s.startDate);
          return `${d.month}月${d.day}日 終日`;
        })();
    return (
      <Pressable
        key={s.id}
        onPress={() => onSelect(s)}
        style={{ flexDirection: "row", gap: 10, paddingVertical: 9 }}
      >
        <View style={{ width: 4, borderRadius: 2, backgroundColor: s.color }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: "600" }} numberOfLines={1}>
            {s.title || "(タイトルなし)"}
          </Text>
          <Text style={{ fontSize: 12, color: t.inkSub }} numberOfLines={1}>
            {when}
            {s.location ? ` ・ ${s.location}` : ""}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, padding: 20, backgroundColor: t.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="予定を検索(タイトル・場所・ゲスト)"
            autoFocus
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: t.line,
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              fontSize: 15,
            }}
          />
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: t.accent, fontSize: 15, fontWeight: "700" }}>閉じる</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {query.trim() !== "" && hits.length === 0 ? (
            <Text style={{ color: t.inkSub, marginTop: 8 }}>見つかりませんでした。</Text>
          ) : null}
          {upcoming.length > 0 ? (
            <Text style={{ fontSize: 12, color: t.inkSub, marginTop: 4 }}>これから</Text>
          ) : null}
          {upcoming.map(row)}
          {past.length > 0 ? (
            <Text style={{ fontSize: 12, color: t.inkSub, marginTop: 12 }}>過去</Text>
          ) : null}
          {past.map(row)}
        </ScrollView>
      </View>
    </Modal>
  );
}
