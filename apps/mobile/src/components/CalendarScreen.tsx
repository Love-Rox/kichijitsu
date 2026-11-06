import { Temporal } from "@js-temporal/polyfill";
import { useMemo, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import type { CalendarData } from "../lib/calendarData";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import { createEvent, deleteEvent, type ApplyChange, type EventSubject } from "../lib/mutations";
import { EventDetailSheet } from "./EventDetailSheet";
import { EventFormSheet } from "./EventFormSheet";
import { MonthAgenda } from "./MonthAgenda";
import { ThreeDayTimeline } from "./ThreeDayTimeline";

type View3 = "3day" | "month";
const ACCENT = "#c13625";

/** ログイン後のメイン画面。3日表示と月表示を、共通のヘッダー(移動・今日・切り替え)で切り替える。 */
export function CalendarScreen({
  data,
  onChange,
}: {
  data: CalendarData;
  /** 楽観的な変更を画面のデータへ反映する(保存は変更の側で行う)。 */
  onChange: ApplyChange;
}) {
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), []);
  const today = useMemo(() => Temporal.Now.plainDateISO(timeZone), [timeZone]);
  const [view, setView] = useState<View3>("3day");
  // 3日表示では先頭日、月表示では表示中の月(と、選んだ日)を兼ねる
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [detail, setDetail] = useState<EventSubject | null>(null);
  /** 作成フォームを開いているときの、開始の初期値 (null = 閉じている)。 */
  const [formStartMs, setFormStartMs] = useState<number | null>(null);

  /** 作成の初期の開始: 表示中の日が今日なら次の正時、それ以外ならその日の 9 時。 */
  const openForm = () => {
    const day = view === "3day" ? (anchor.until(today).days >= 0 && anchor.until(today).days < 3 ? today : anchor) : selected;
    const now = Date.now();
    const start = day.equals(today)
      ? Math.ceil(now / 3_600_000) * 3_600_000
      : dayStartMs(day, timeZone) + 9 * 3_600_000;
    setFormStartMs(start);
  };

  const move = (dir: 1 | -1) => {
    setAnchor((a) => (view === "3day" ? a.add({ days: 3 * dir }) : a.add({ months: dir }).with({ day: 1 })));
  };
  const goToday = () => {
    setAnchor(today);
    setSelected(today);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 10 }}>
        <Pressable onPress={() => move(-1)} hitSlop={8}>
          <Text style={{ fontSize: 22 }}>‹</Text>
        </Pressable>
        <Pressable onPress={goToday} hitSlop={8}>
          <Text style={{ fontSize: 14, color: ACCENT }}>今日</Text>
        </Pressable>
        <Pressable onPress={() => move(1)} hitSlop={8}>
          <Text style={{ fontSize: 22 }}>›</Text>
        </Pressable>
        <Text style={{ fontSize: 15, fontWeight: "600" }}>
          {anchor.year}年{anchor.month}月
        </Text>
        <Pressable onPress={openForm} hitSlop={8} style={{ marginLeft: "auto" }}>
          <Text style={{ fontSize: 24, color: ACCENT }}>＋</Text>
        </Pressable>
        <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: "#ddd", overflow: "hidden" }}>
          {([["3day", "3日"], ["month", "月"]] as const).map(([v, label]) => (
            <Pressable
              key={v}
              onPress={() => setView(v)}
              style={{ paddingHorizontal: 12, paddingVertical: 4, backgroundColor: view === v ? ACCENT : undefined }}
            >
              <Text style={{ fontSize: 13, color: view === v ? "#fff" : "#555" }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {view === "3day" ? (
        <ThreeDayTimeline
          data={data}
          start={anchor}
          today={today}
          timeZone={timeZone}
          onSelect={setDetail}
        />
      ) : (
        <MonthAgenda
          data={data}
          month={anchor}
          today={today}
          selected={selected}
          timeZone={timeZone}
          onSelect={setSelected}
          onSelectEvent={setDetail}
        />
      )}

      {formStartMs !== null && (
        <EventFormSheet
          visible
          initialStartMs={formStartMs}
          timeZone={timeZone}
          accountId={data.accountId}
          calendars={data.calendars}
          onClose={() => setFormStartMs(null)}
          onSubmit={(draft, target) => {
            setFormStartMs(null);
            createEvent(draft, target, timeZone, onChange).catch((e) =>
              Alert.alert("作成できませんでした", "もう一度お試しください。\n" + String(e)),
            );
          }}
        />
      )}

      <EventDetailSheet
        subject={detail}
        timeZone={timeZone}
        onClose={() => setDetail(null)}
        onDelete={(subject, notify) => deleteEvent(subject, notify, onChange, data)}
      />
    </View>
  );
}
