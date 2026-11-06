import { Temporal } from "@js-temporal/polyfill";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import { layoutOverlaps } from "@kichijitsu/web/layout/overlapLayout";
import { allDaysOnDate, occurrencesInRange, type CalendarData } from "../lib/calendarData";

/**
 * 3日表示のタイムライン (モバイルの既定ビュー)。
 * 予定の変換・繰り返し展開・重なり配置は Web 版と同じロジック (apps/web/src) をそのまま使う。
 */
const HOUR_HEIGHT = 52;
const GUTTER = 40;
const DAYS = 3;
/** 見出しの窓: 重なり配置が「予定の先頭が隠れない」ことを保証する範囲 (Web 版の EVENT_HEADER_PX=36 を標準ズームの分に直したもの) */
const HEADER_WINDOW_MS = 36 * 60_000;
const ACCENT = "#c13625";
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function ThreeDayTimeline({ data }: { data: CalendarData }) {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), []);
  const today = useMemo(() => Temporal.Now.plainDateISO(timeZone), [timeZone]);
  const [start, setStart] = useState(today);

  const days = useMemo(
    () => Array.from({ length: DAYS }, (_, i) => start.add({ days: i })),
    [start],
  );

  const columns = useMemo(() => {
    return days.map((date) => {
      const dayStart = dayStartMs(date, timeZone);
      const dayEnd = dayStartMs(date.add({ days: 1 }), timeZone);
      const items = occurrencesInRange(data, dayStart, dayEnd).filter(
        (o) => !o.isOutOfOffice && !o.isWorkingLocation && o.responseStatus !== "declined",
      );
      const slots = layoutOverlaps(
        items.map((o) => ({
          id: o.id,
          startMs: Math.max(o.startMs, dayStart),
          endMs: Math.min(o.endMs, dayEnd),
          background: false,
        })),
        HEADER_WINDOW_MS,
      );
      return { date, dayStart, dayEnd, items, slots, allDay: allDaysOnDate(data, date) };
    });
  }, [days, data, timeZone]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 8 }}>
        <Pressable onPress={() => setStart(start.subtract({ days: DAYS }))} hitSlop={8}>
          <Text style={{ fontSize: 20 }}>‹</Text>
        </Pressable>
        <Pressable onPress={() => setStart(today)} hitSlop={8}>
          <Text style={{ fontSize: 14, color: ACCENT }}>今日</Text>
        </Pressable>
        <Pressable onPress={() => setStart(start.add({ days: DAYS }))} hitSlop={8}>
          <Text style={{ fontSize: 20 }}>›</Text>
        </Pressable>
        <Text style={{ marginLeft: "auto", color: "#666" }}>
          {days[0].year}年{days[0].month}月
        </Text>
      </View>

      <View style={{ flexDirection: "row", marginLeft: GUTTER }}>
        {columns.map(({ date, allDay }) => {
          const isToday = date.equals(today);
          return (
            <View key={date.toString()} style={{ flex: 1, alignItems: "center", paddingBottom: 4 }}>
              <Text style={{ fontSize: 12, color: isToday ? ACCENT : "#666" }}>
                {WEEKDAYS[date.dayOfWeek - 1]}
              </Text>
              <Text style={{ fontSize: 18, fontWeight: "700", color: isToday ? ACCENT : "#111" }}>
                {date.day}
              </Text>
              {allDay.slice(0, 2).map((a) => (
                <Text
                  key={a.id}
                  numberOfLines={1}
                  style={{
                    alignSelf: "stretch",
                    marginHorizontal: 2,
                    marginTop: 2,
                    paddingHorizontal: 3,
                    fontSize: 11,
                    borderRadius: 3,
                    backgroundColor: `${a.color}33`,
                    color: "#222",
                  }}
                >
                  {a.title}
                </Text>
              ))}
            </View>
          );
        })}
      </View>

      <ScrollView
        contentOffset={{ x: 0, y: 7 * HOUR_HEIGHT }}
        style={{ flex: 1, borderTopWidth: 1, borderTopColor: "#e5e7eb" }}
      >
        <View style={{ flexDirection: "row", height: 24 * HOUR_HEIGHT }}>
          <View style={{ width: GUTTER }}>
            {Array.from({ length: 24 }, (_, h) => (
              <Text
                key={h}
                style={{
                  position: "absolute",
                  top: h * HOUR_HEIGHT - 7,
                  right: 6,
                  fontSize: 11,
                  color: "#888",
                }}
              >
                {h === 0 ? "" : `${h}:00`}
              </Text>
            ))}
          </View>
          {columns.map(({ date, dayStart, dayEnd, items, slots }) => (
            <View
              key={date.toString()}
              style={{ flex: 1, borderLeftWidth: 1, borderLeftColor: "#e5e7eb" }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <View
                  key={h}
                  style={{
                    position: "absolute",
                    top: h * HOUR_HEIGHT,
                    left: 0,
                    right: 0,
                    height: 1,
                    backgroundColor: "#f0f0f0",
                  }}
                />
              ))}
              {items.map((o) => {
                const slot = slots.get(o.id);
                if (!slot) return null;
                const s = Math.max(o.startMs, dayStart);
                const e = Math.min(o.endMs, dayEnd);
                const top = ((s - dayStart) / 3_600_000) * HOUR_HEIGHT;
                const height = Math.max(((e - s) / 3_600_000) * HOUR_HEIGHT, 18);
                return (
                  <View
                    key={o.id}
                    style={{
                      position: "absolute",
                      top,
                      height: height - 1,
                      left: `${slot.leftFrac * 100}%`,
                      width: `${slot.widthFrac * 100}%`,
                      zIndex: slot.stackIndex,
                      paddingHorizontal: 3,
                      paddingVertical: 1,
                      borderLeftWidth: 3,
                      borderLeftColor: o.color,
                      borderRadius: 4,
                      backgroundColor: `${o.color}2b`,
                      overflow: "hidden",
                    }}
                  >
                    <Text numberOfLines={height > 36 ? 2 : 1} style={{ fontSize: 11, color: "#111" }}>
                      {o.title}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
