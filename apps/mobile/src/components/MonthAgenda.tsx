import type { Temporal } from "@js-temporal/polyfill";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { monthGridWeeks } from "@kichijitsu/web/layout/monthGrid";
import type { CalendarData } from "../lib/calendarData";
import { eventsOnDate, type DayEvents } from "../lib/dayEvents";

/**
 * 月表示 + 選んだ日のアジェンダ。上に 6 週 × 7 日のグリッド(各日に予定の色つきチップを最大 3 件)、
 * 下に選んだ日の予定の一覧。日をタップすると、その日のアジェンダに切り替わる。
 */
const ACCENT = "#c13625";
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
}: {
  data: CalendarData;
  month: Temporal.PlainDate;
  today: Temporal.PlainDate;
  selected: Temporal.PlainDate;
  timeZone: string;
  onSelect: (date: Temporal.PlainDate) => void;
}) {
  const weeks = useMemo(() => monthGridWeeks(month), [month]);
  const byDate = useMemo(() => {
    const map = new Map<string, DayEvents>();
    for (const week of weeks) {
      for (const { date } of week) map.set(date.toString(), eventsOnDate(data, date, timeZone));
    }
    return map;
  }, [weeks, data, timeZone]);

  const selectedEvents = byDate.get(selected.toString()) ?? eventsOnDate(data, selected, timeZone);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row" }}>
        {WEEKDAYS.map((w, i) => (
          <Text
            key={w}
            style={{ flex: 1, textAlign: "center", fontSize: 11, color: i >= 5 ? ACCENT : "#888" }}
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
                  borderTopColor: "#eee",
                  backgroundColor: isSelected ? "#fdf1ef" : undefined,
                  opacity: inMonth ? 1 : 0.4,
                }}
              >
                <View
                  style={{
                    alignSelf: "center",
                    minWidth: 20,
                    height: 20,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isToday ? ACCENT : undefined,
                  }}
                >
                  <Text style={{ fontSize: 12, color: isToday ? "#fff" : "#111", fontWeight: "600" }}>
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
                      color: "#222",
                      backgroundColor: `${c.color}33`,
                    }}
                  >
                    {c.title}
                  </Text>
                ))}
                {chips.length > MAX_CHIPS && (
                  <Text style={{ fontSize: 9, color: "#888", textAlign: "center" }}>
                    +{chips.length - MAX_CHIPS}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}

      <View style={{ borderTopWidth: 1, borderTopColor: "#e5e7eb", marginTop: 4 }} />
      <ScrollView style={{ flex: 1 }}>
        <Text style={{ fontSize: 13, color: "#666", paddingVertical: 6 }}>
          {selected.month}月{selected.day}日({WEEKDAYS[selected.dayOfWeek - 1]})
        </Text>
        {selectedEvents.allDay.length === 0 && selectedEvents.timed.length === 0 && (
          <Text style={{ color: "#888", paddingVertical: 8 }}>予定はありません</Text>
        )}
        {selectedEvents.allDay.map((a) => (
          <AgendaRow key={a.id} color={a.color} time="終日" title={a.title} />
        ))}
        {selectedEvents.timed.map((o) => (
          <AgendaRow
            key={o.id}
            color={o.color}
            time={`${formatTime(o.startMs, timeZone)}–${formatTime(o.endMs, timeZone)}`}
            title={o.title}
            location={o.location}
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
}: {
  color: string;
  time: string;
  title: string;
  location?: string;
}) {
  return (
    <View style={{ flexDirection: "row", paddingVertical: 6, gap: 8 }}>
      <View style={{ width: 4, borderRadius: 2, backgroundColor: color }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, color: "#666" }}>{time}</Text>
        <Text style={{ fontSize: 15 }}>{title}</Text>
        {location ? (
          <Text numberOfLines={1} style={{ fontSize: 12, color: "#888" }}>
            {location}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
