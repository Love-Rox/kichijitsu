import { useTheme } from "../theme";
import type { Temporal } from "@js-temporal/polyfill";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./ui";
import { monthGridWeeks } from "@kichijitsu/web/layout/monthGrid";
import type { CalendarData } from "../lib/calendarData";
import { eventsByDates, eventsOnDate } from "../lib/dayEvents";
import type { EventSubject } from "../lib/mutations";

/**
 * 月表示 + 選んだ日のアジェンダ。上に 6 週 × 7 日のグリッド(各日に予定の色つきチップを最大 3 件)、
 * 下に選んだ日の予定の一覧。日をタップすると、その日のアジェンダに切り替わる。
 */
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const MAX_CHIPS = 3;

function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

export function MonthAgenda({
  data,
  month,
  today,
  selected,
  timeZone,
  onSelect,
  onSelectEvent,
}: {
  data: CalendarData;
  month: Temporal.PlainDate;
  today: Temporal.PlainDate;
  selected: Temporal.PlainDate;
  timeZone: string;
  onSelect: (date: Temporal.PlainDate) => void;
  onSelectEvent: (subject: EventSubject) => void;
}) {
  const t = useTheme();
  const weeks = useMemo(() => monthGridWeeks(month), [month]);
  // 6 週ぶん(42 日)を、1 回の展開で求める(日ごとに展開し直さない)
  const byDate = useMemo(
    () => eventsByDates(data, weeks.flat().map((d) => d.date), timeZone),
    [weeks, data, timeZone],
  );

  const selectedEvents = byDate.get(selected.toString()) ?? eventsOnDate(data, selected, timeZone);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row" }}>
        {WEEKDAYS.map((w, i) => (
          <Text
            key={w}
            style={{ flex: 1, textAlign: "center", fontSize: 11, color: i >= 5 ? t.accent : t.inkSub }}
          >
            {w}
          </Text>
        ))}
      </View>

      {weeks.map((week) => (
        <View key={week[0].date.toString()} style={{ flexDirection: "row" }}>
          {week.map(({ date, inMonth }) => {
            const ev = byDate.get(date.toString());
            const chips = [
              ...(ev?.allDay ?? []).map((a) => ({ id: a.id, title: a.title, color: a.color })),
              ...(ev?.timed ?? []).map((o) => ({ id: o.id, title: o.title, color: o.color })),
            ];
            const isToday = date.equals(today);
            const isSelected = date.equals(selected);
            return (
              <Pressable
                key={date.toString()}
                onPress={() => onSelect(date)}
                style={{
                  flex: 1,
                  height: 74,
                  paddingTop: 2,
                  borderTopWidth: 1,
                  borderTopColor: t.lineWarm,
                  backgroundColor: isSelected ? t.accentSoft : undefined,
                  opacity: inMonth ? 1 : 0.4,
                }}
              >
                <View
                  style={{
                    alignSelf: "center",
                    minWidth: 20,
                    height: 20,
                    borderRadius: 5, // 枡(26% 角丸)
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isToday ? t.accent : undefined,
                    transform: isToday ? [{ rotate: "-8deg" }] : undefined,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      color: isToday ? t.onAccent : t.ink,
                      fontWeight: "600",
                      transform: isToday ? [{ rotate: "8deg" }] : undefined,
                    }}
                  >
                    {date.day}
                  </Text>
                </View>
                {chips.slice(0, MAX_CHIPS).map((c) => (
                  <Text
                    key={c.id}
                    numberOfLines={1}
                    style={{
                      marginTop: 1,
                      marginHorizontal: 1,
                      paddingHorizontal: 2,
                      fontSize: 9,
                      borderRadius: 2,
                      color: t.ink,
                      backgroundColor: t.chipBg(c.color),
                    }}
                  >
                    {c.title}
                  </Text>
                ))}
                {chips.length > MAX_CHIPS && (
                  <Text style={{ fontSize: 9, color: t.inkSub, textAlign: "center" }}>
                    +{chips.length - MAX_CHIPS}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}

      <View style={{ borderTopWidth: 1, borderTopColor: t.line, marginTop: 4 }} />
      <ScrollView style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, color: t.inkMute, paddingVertical: 6 }}>
          {selected.month}月{selected.day}日({WEEKDAYS[selected.dayOfWeek - 1]})
        </Text>
        {selectedEvents.allDay.length === 0 && selectedEvents.timed.length === 0 && (
          <Text style={{ color: t.inkSub, paddingVertical: 8 }}>予定はありません</Text>
        )}
        {selectedEvents.allDay.map((a) => (
          <AgendaRow key={a.id} color={a.color} time="終日" title={a.title} onPress={() => onSelectEvent(a)} />
        ))}
        {selectedEvents.timed.map((o) => (
          <AgendaRow
            key={o.id}
            color={o.color}
            time={`${formatTime(o.startMs, timeZone)}–${formatTime(o.endMs, timeZone)}`}
            title={o.title}
            location={o.location}
            onPress={() => onSelectEvent(o)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function AgendaRow({
  color,
  time,
  title,
  location,
  onPress,
}: {
  color: string;
  time: string;
  title: string;
  location?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={{ flexDirection: "row", paddingVertical: 6, gap: 8 }}>
      <View style={{ width: 4, borderRadius: 2, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, color: t.inkMute }}>{time}</Text>
        <Text style={{ fontSize: 15 }}>{title}</Text>
        {location ? (
          <Text numberOfLines={1} style={{ fontSize: 12, color: t.inkSub }}>
            {location}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
