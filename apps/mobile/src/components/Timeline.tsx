import { useTheme } from "../theme";
import { Temporal } from "@js-temporal/polyfill";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./ui";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import { layoutOverlaps } from "@kichijitsu/web/layout/overlapLayout";
import { allDaysOnDate, occurrencesInRange, type CalendarData } from "../lib/calendarData";
import type { EventSubject } from "../lib/mutations";

/**
 * 日 / 3日 / 週 のタイムライン (3日がモバイルの既定ビュー)。表示する日数は dayCount で決まる。
 * 予定の変換・繰り返し展開・重なり配置は Web 版と同じロジック (apps/web/src) をそのまま使う。
 */
const HOUR_HEIGHT = 52;
const GUTTER = 40;
/** 見出しの窓: 重なり配置が「予定の先頭が隠れない」ことを保証する範囲 (Web 版の EVENT_HEADER_PX=36 を標準ズームの分に直したもの) */
const HEADER_WINDOW_MS = 36 * 60_000;
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function Timeline({
  data,
  start,
  dayCount,
  today,
  timeZone,
  onSelect,
}: {
  data: CalendarData;
  /** 表示する日数 (1 = 日、3 = 3日、7 = 週)。 */
  dayCount: number;
  start: Temporal.PlainDate;
  today: Temporal.PlainDate;
  timeZone: string;
  onSelect: (subject: EventSubject) => void;
}) {
  const t = useTheme();

  /** 列が狭い表示(週)かどうか。予定の文字・余白を詰める。 */
  const compact = dayCount >= 5;

  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => start.add({ days: i })),
    [start, dayCount],
  );

  const columns = useMemo(() => {
    return days.map((date) => {
      const dayStart = dayStartMs(date, timeZone);
      const dayEnd = dayStartMs(date.add({ days: 1 }), timeZone);
      const items = occurrencesInRange(data, dayStart, dayEnd).filter(
        (o) => !o.isWorkingLocation && o.responseStatus !== "declined",
      );
      const slots = layoutOverlaps(
        items.map((o) => ({
          id: o.id,
          startMs: Math.max(o.startMs, dayStart),
          endMs: Math.min(o.endMs, dayEnd),
          // 不在は、他の予定の幅を奪わない背景の層として描く(全幅・最背面)
          background: o.isOutOfOffice === true,
        })),
        HEADER_WINDOW_MS,
      );
      return { date, dayStart, dayEnd, items, slots, allDay: allDaysOnDate(data, date) };
    });
  }, [days, data, timeZone]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", marginLeft: GUTTER }}>
        {columns.map(({ date, allDay }) => {
          const isToday = date.equals(today);
          return (
            <View key={date.toString()} style={{ flex: 1, alignItems: "center", paddingBottom: 4 }}>
              <Text style={{ fontSize: 12, color: isToday ? t.accent : t.inkMute }}>
                {WEEKDAYS[date.dayOfWeek - 1]}
              </Text>
              <View
                style={{
                  minWidth: 28,
                  height: 28,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 7, // 枡(26% 角丸)
                  backgroundColor: isToday ? t.accent : undefined,
                  transform: isToday ? [{ rotate: "-8deg" }] : undefined,
                }}
              >
                <Text
                  style={{
                    fontSize: 17,
                    fontWeight: "700",
                    color: isToday ? t.onAccent : t.ink,
                    transform: isToday ? [{ rotate: "8deg" }] : undefined,
                  }}
                >
                  {date.day}
                </Text>
              </View>
              {allDay.slice(0, 2).map((a) => (
                <Text
                  key={a.id}
                  onPress={() => onSelect(a)}
                  numberOfLines={1}
                  style={{
                    alignSelf: "stretch",
                    marginHorizontal: 2,
                    marginTop: 2,
                    paddingHorizontal: 3,
                    fontSize: 11,
                    borderRadius: 3,
                    backgroundColor: t.allDayBg(a.color),
                    color: t.ink,
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
        style={{ flex: 1, borderTopWidth: 1, borderTopColor: t.line }}
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
                  color: t.inkSub,
                }}
              >
                {h === 0 ? "" : `${h}:00`}
              </Text>
            ))}
          </View>
          {columns.map(({ date, dayStart, dayEnd, items, slots }) => (
            <View
              key={date.toString()}
              style={{
                flex: 1,
                borderLeftWidth: 1,
                borderLeftColor: t.line,
                // 今日の列は、デスクトップ版と同じく hoverTint をごく薄く敷く
                backgroundColor: date.equals(today) ? t.todayBg : undefined,
              }}
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
                    backgroundColor: t.lineWarm,
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
                  <Pressable
                    key={o.id}
                    onPress={() => onSelect(o)}
                    style={{
                      position: "absolute",
                      top,
                      height: height - 1,
                      left: `${slot.leftFrac * 100}%`,
                      width: `${slot.widthFrac * 100}%`,
                      zIndex: slot.stackIndex,
                      paddingHorizontal: compact ? 1 : 3,
                      paddingVertical: 1,
                      borderLeftWidth: compact ? 2 : 3,
                      borderLeftColor: o.isOutOfOffice ? t.uiInkFaint : o.color,
                      borderRadius: 4,
                      backgroundColor: o.isOutOfOffice ? `${t.uiInkFaint}40` : t.eventBg(o.color),
                      overflow: "hidden",
                    }}
                  >
                    <Text
                      // 行数は、ブロックの高さに収まる分だけ(狭い列で、1 文字ずつ折り返されて
                      // 縦に伸びすぎないように)。週表示は、列が狭いので文字も小さくする
                      numberOfLines={Math.max(1, Math.floor((height - 2) / (compact ? 12 : 14)))}
                      style={{ fontSize: compact ? 9.5 : 11, lineHeight: compact ? 12 : 14, color: t.ink }}
                    >
                      {o.isOutOfOffice ? `不在 ${o.title}` : o.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
