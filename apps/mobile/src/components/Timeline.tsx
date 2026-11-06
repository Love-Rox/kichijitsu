import { useTheme } from "../theme";
import { Temporal } from "@js-temporal/polyfill";
import { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, View } from "react-native";
import { Text } from "./ui";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import { layoutOverlaps } from "@kichijitsu/web/layout/overlapLayout";
import { allDaysOnDate, occurrencesByDay, type CalendarData } from "../lib/calendarData";
import type { Occurrence } from "@kichijitsu/web/model/types";
import { isEditableEventSubject } from "@kichijitsu/web/sync/eventEdit";
import { formatTime } from "../lib/format";
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
/** ドラッグで時間を動かすときの刻み(15 分)。 */
const SNAP_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
/** ドラッグ中の予定。mode: move=掴んで動かす、resize=下端を掴んで終了を動かす。 */
interface DragState {
  o: Occurrence;
  mode: "move" | "resize";
  startMs: number;
  endMs: number;
}

export function Timeline({
  data,
  start,
  dayCount,
  today,
  timeZone,
  onSelect,
  onMove,
}: {
  data: CalendarData;
  /**
   * 予定をドラッグで動かした(または終了時刻を伸縮した)ときの保存。長押しで掴んで、縦に動かすと時刻、
   * 横に動かすと日が変わる(15 分刻み)。保存が終わるまで、動かした後の位置を表示し続ける。
   */
  onMove?: (o: Occurrence, startMs: number, endMs: number) => Promise<void>;
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

  // ---- ドラッグ(長押しで予定を掴む) ----
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 保存の応答待ちの間、動かした後の位置を出し続けるための値(完了で外す)。 */
  const [pending, setPending] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const latest = useRef<DragState | null>(null);
  const rowWidth = useRef(0);
  // PanResponder は一度だけ作るので、最新の値は ref 越しに読む
  const live = useRef({ days, dayCount, timeZone, onMove });
  live.current = { days, dayCount, timeZone, onMove };

  const dayIndexOf = (ms: number) =>
    live.current.days.findIndex(
      (d) =>
        ms >= dayStartMs(d, live.current.timeZone) &&
        ms < dayStartMs(d.add({ days: 1 }), live.current.timeZone),
    );

  /** 掴んだ位置からの移動量 (dx, dy) から、動かした後の開始・終了を求める。 */
  const compute = (base: DragState, dx: number, dy: number): DragState => {
    const { days: ds, dayCount: n, timeZone: tz } = live.current;
    const deltaMs = Math.round((dy / HOUR_HEIGHT) * 60 / 15) * SNAP_MS;
    if (base.mode === "resize") {
      return { ...base, endMs: Math.max(base.startMs + SNAP_MS, base.endMs + deltaMs) };
    }
    const colW = (rowWidth.current - GUTTER) / n;
    const from = dayIndexOf(base.startMs);
    let dayDelta = 0;
    if (from >= 0 && colW > 0) {
      const to = Math.min(n - 1, Math.max(0, from + Math.round(dx / colW)));
      dayDelta = dayStartMs(ds[to], tz) - dayStartMs(ds[from], tz);
    }
    const startMs = base.startMs + deltaMs + dayDelta;
    return { ...base, startMs, endMs: startMs + (base.endMs - base.startMs) };
  };

  const finish = (commit: boolean) => {
    const base = dragRef.current;
    const result = latest.current;
    dragRef.current = null;
    latest.current = null;
    setDrag(null);
    if (!commit || !base || !result) return;
    if (result.startMs === base.startMs && result.endMs === base.endMs) return;
    const cb = live.current.onMove;
    if (!cb) return;
    setPending(result);
    void cb(result.o, result.startMs, result.endMs)
      .catch(() => undefined)
      .finally(() => setPending(null));
  };

  const pan = useRef(
    PanResponder.create({
      // 長押しでドラッグ中になったら、以後の指の動きを、ここで奪う(子の Pressable・スクロールより優先)
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: () => dragRef.current !== null,
      onPanResponderMove: (_, g) => {
        const base = dragRef.current;
        if (!base) return;
        const next = compute(base, g.dx, g.dy);
        latest.current = next;
        setDrag(next);
      },
      onPanResponderRelease: () => finish(true),
      onPanResponderTerminate: () => finish(false),
    }),
  ).current;

  const startDrag = (o: Occurrence, mode: DragState["mode"]) => {
    if (!live.current.onMove || !isEditableEventSubject(o) || o.isOutOfOffice) return;
    const base = { o, mode, startMs: o.startMs, endMs: o.endMs };
    dragRef.current = base;
    latest.current = base;
    setDrag(base);
  };

  const columns = useMemo(() => {
    // 表示する範囲全体で、予定の展開を 1 回だけ行い、日に振り分ける(日ごとに展開し直さない)
    const byDay = occurrencesByDay(data, days, timeZone);
    return days.map((date) => {
      const dayStart = dayStartMs(date, timeZone);
      const dayEnd = dayStartMs(date.add({ days: 1 }), timeZone);
      const items = (byDay.get(date.toString()) ?? [])
        .filter((o) => !o.isWorkingLocation && o.responseStatus !== "declined")
        // 保存の応答待ちの予定は、動かした後の位置(別の日になることもある)で出す
        .filter((o) => !pending || o.id !== pending.o.id);
      if (pending && pending.startMs < dayEnd && pending.endMs > dayStart) {
        items.push({ ...pending.o, startMs: pending.startMs, endMs: pending.endMs });
      }
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
  }, [days, data, timeZone, pending]);

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
        // 予定を掴んでいる間は、スクロールさせない(指の縦の動きを、予定の移動に使うため)
        scrollEnabled={drag === null}
        style={{ flex: 1, borderTopWidth: 1, borderTopColor: t.line }}
      >
        <View
          style={{ flexDirection: "row", height: 24 * HOUR_HEIGHT }}
          onLayout={(e) => {
            rowWidth.current = e.nativeEvent.layout.width;
          }}
          {...pan.panHandlers}
        >
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
                    onLongPress={() => startDrag(o, "move")}
                    delayLongPress={300}
                    style={{
                      opacity: drag?.o.id === o.id ? 0.3 : 1,
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
                    {/* 下端: 長押しで掴むと、終了時刻を伸縮できる(十分な高さの予定だけ) */}
                    {onMove && height >= 32 && isEditableEventSubject(o) && !o.isOutOfOffice ? (
                      <Pressable
                        onLongPress={() => startDrag(o, "resize")}
                        delayLongPress={250}
                        style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 14, alignItems: "center", justifyContent: "flex-end" }}
                      >
                        <View style={{ width: 16, height: 3, borderRadius: 2, marginBottom: 2, backgroundColor: t.inkFaint }} />
                      </Pressable>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}

          {/* ドラッグ中の予定の、動かした後の位置(掴んだ予定の上に、半透明の枠で重ねる) */}
          {drag && dayIndexOf(drag.startMs) >= 0 ? (
            (() => {
              const idx = dayIndexOf(drag.startMs);
              const colW = (rowWidth.current - GUTTER) / dayCount;
              const top = ((drag.startMs - dayStartMs(days[idx], timeZone)) / HOUR_MS) * HOUR_HEIGHT;
              const height = Math.max(((drag.endMs - drag.startMs) / HOUR_MS) * HOUR_HEIGHT, 22);
              return (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: GUTTER + idx * colW + 1,
                    width: colW - 2,
                    top,
                    height,
                    zIndex: 1000,
                    borderRadius: 4,
                    borderWidth: 2,
                    borderColor: t.accent,
                    backgroundColor: t.eventBg(drag.o.color),
                    padding: 2,
                  }}
                >
                  <Text numberOfLines={1} style={{ fontSize: 10, fontWeight: "700" }}>
                    {formatTime(drag.startMs, timeZone)}–{formatTime(drag.endMs, timeZone)}
                  </Text>
                  <Text numberOfLines={2} style={{ fontSize: 10 }}>
                    {drag.o.title}
                  </Text>
                </View>
              );
            })()
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
