import { useTheme } from "../theme";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Animated, AppState, PanResponder, Pressable, useWindowDimensions, View, type GestureResponderEvent, type HostInstance, type ScrollViewInstance } from "react-native";
import { FONT_SCALE, Text } from "./ui";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import { layoutOverlaps, STACK_INDENT_FRAC } from "@kichijitsu/web/layout/overlapLayout";
import { allDaysOnDate, occurrencesByDay, type CalendarData } from "../lib/calendarData";
import type { Occurrence } from "@kichijitsu/web/model/types";
import { isEditableEventSubject } from "@kichijitsu/web/sync/eventEdit";
import { formatTime } from "../lib/format";
import { getMeta, setMeta } from "../lib/localDb";
import type { EventSubject } from "../lib/mutations";
import { Icon } from "./Icon";

/**
 * 日 / 3日 / 週 のタイムライン (3日がモバイルの既定ビュー)。表示する日数は dayCount で決まる。
 * 予定の変換・繰り返し展開・重なり配置は Web 版と同じロジック (apps/web/src) をそのまま使う。
 */
const DEFAULT_HOUR_HEIGHT = 52;
/** ピンチで変えられる 1 時間の高さ(px)の範囲。下限は 24 時間がほぼ 1 画面に入る高さ。 */
const MIN_HOUR_HEIGHT = 28;
const MAX_HOUR_HEIGHT = 160;
const ZOOM_KEY = "timelineHourHeight";
const clampHourHeight = (h: number) => Math.round(Math.min(MAX_HOUR_HEIGHT, Math.max(MIN_HOUR_HEIGHT, h)));
const GUTTER = 40;
/** 見出しの窓: 重なり配置が「予定の先頭が隠れない」ことを保証する高さ(px)。Web 版の EVENT_HEADER_PX=36 を標準ズームの分に直したもの(36 分 × 52px/時) */
const HEADER_WINDOW_PX = (36 / 60) * DEFAULT_HOUR_HEIGHT;
/** 重なる予定の、下の予定の端が見える最小の幅(px)。左端の色の線(2〜3px)と、その右の地が見える程度 */
const MIN_STACK_INDENT_PX = 8;

/** 時刻付きの勤務場所の帯(列の左端)の幅(px) */
const WORKING_LOCATION_RAIL_PX = 4;
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
/** ドラッグで時間を動かすときの刻み(15 分)。 */
const SNAP_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
/**
 * 横に並べる日数(長い巻き紙の長さ)。表示するのは、そのうちの dayCount 日ぶんで、横にスクロールすると、
 * 前後の日が連続して見える。端に近づいたら、見えない所で、範囲を入れ替える(内容は同じなので、気付かない)。
 */
const WINDOW_DAYS = 41;
/** 巻き紙の先頭から、表示の先頭日までの日数(範囲の入れ替えの後も、この位置に置く)。 */
const BEFORE_DAYS = 16;
/** 端からこの日数より近づいたら、範囲を入れ替える。 */
const EDGE_DAYS = 5;
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
  onVisibleStart,
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
  /** 横にスクロールして、表示の先頭日が変わった(指を離して止まった)とき。 */
  onVisibleStart?: (start: Temporal.PlainDate) => void;
}) {
  const t = useTheme();

  /** 列が狭い表示(週)かどうか。予定の文字・余白を詰める。 */
  const compact = dayCount >= 5;

  // ---- 横の巻き紙 ----
  // 前後に長く並べた日の列を、横のスクロールで連続して動かす。1 列の幅で止まる(吸着)。
  const { width: screenW } = useWindowDimensions();
  const colW = Math.max(1, (screenW - GUTTER) / dayCount);
  const [windowStart, setWindowStart] = useState(() => start.subtract({ days: BEFORE_DAYS }));
  const days = useMemo(
    () => Array.from({ length: WINDOW_DAYS }, (_, i) => windowStart.add({ days: i })),
    [windowStart],
  );
  const hScrollRef = useRef<ScrollViewInstance>(null);
  /** 横のスクロール位置(ネイティブ側で更新)。日付の見出しを、帯と同じだけ動かすのに使う。 */
  const scrollX = useRef(new Animated.Value(0)).current;
  const curX = useRef(0);
  const startRef = useRef(start);
  startRef.current = start;
  const idxOf = (d: Temporal.PlainDate) => windowStart.until(d, { largestUnit: "days" }).days;
  const [initialX] = useState(() => BEFORE_DAYS * colW);

  // 帯の範囲か、1 列の幅が変わったら、表示の先頭日が左端に来るように合わせる(アニメーションなし)
  useLayoutEffect(() => {
    const x = idxOf(startRef.current) * colW;
    hScrollRef.current?.scrollTo({ x, animated: false });
    scrollX.setValue(x);
    curX.current = x;
  }, [colW, windowStart]);

  // 表示の先頭日が外から変わった(前へ/次へ・今日・表示の切り替え)とき: 帯の中なら、そこまで動かす。外なら、範囲を入れ替える
  useEffect(() => {
    const idx = idxOf(start);
    if (idx < 0 || idx > WINDOW_DAYS - dayCount) {
      setWindowStart(start.subtract({ days: BEFORE_DAYS }));
      return;
    }
    const x = idx * colW;
    if (Math.abs(x - curX.current) > 1) hScrollRef.current?.scrollTo({ x, animated: true });
  }, [start]);

  /** 指を離して止まったとき: 左端の日を求めて伝える。端に近ければ、範囲を入れ替える。 */
  const settleX = (x: number) => {
    const idx = Math.round(x / colW);
    const d = windowStart.add({ days: idx });
    if (!d.equals(startRef.current)) onVisibleStart?.(d);
    if (idx < EDGE_DAYS || idx > WINDOW_DAYS - dayCount - EDGE_DAYS) {
      setWindowStart(d.subtract({ days: BEFORE_DAYS }));
    }
  };

  // ---- 縦の拡大・縮小(2 本指のピンチ) ----
  const [hourHeight, setHourHeight] = useState(DEFAULT_HOUR_HEIGHT);
  const [pinching, setPinching] = useState(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const wrapRef = useRef<HostInstance>(null);
  const scrollY = useRef(0);
  // スクロール位置(ネイティブ側で、毎フレーム更新)。長い予定のタイトルを、見えている範囲の最上部へ寄せるのに使う
  const scrollAnim = useRef(new Animated.Value(0)).current;
  /** 拡大・縮小の後に合わせるスクロール位置(描画のあと、高さが変わってから反映する)。 */
  const pendingScroll = useRef<number | null>(null);
  /** ピンチの間の基準: 開始時の指の間隔・倍率・スクロール位置、指の中心の画面内の位置、窓の上端。 */
  const pinchBase = useRef({ dist: 1, h0: DEFAULT_HOUR_HEIGHT, y0: 0, focal0: 0, top: 0 });
  const hourHeightRef = useRef(hourHeight);
  hourHeightRef.current = hourHeight;

  /**
   * 開いたときに見せる位置(px): 今日が範囲に入っていれば現在時刻の少し上、そうでなければ 7 時。
   * 倍率(1 時間の高さ)によって位置が変わるので、倍率を引数に取る。
   */
  const initialOffsetFor = (h: number) => {
    const n = Date.now();
    const inRange = Array.from({ length: dayCount }, (_, i) => start.add({ days: i })).some(
      (d) => n >= dayStartMs(d, timeZone) && n < dayStartMs(d.add({ days: 1 }), timeZone),
    );
    if (!inRange) return 7 * h;
    const hour = (n - dayStartMs(Temporal.Now.plainDateISO(timeZone), timeZone)) / HOUR_MS;
    // 画面の下端より上に収まるよう、24 時間分の高さを超えない範囲で
    return Math.max(0, Math.min((hour - 2) * h, 14 * h));
  };
  /**
   * 利用者がスクロールやピンチをしたか。まだなら、スクロール位置は開いたときの初期位置のまま
   * (初期位置の設定では onScroll が鳴らず、scrollY は 0 のままなので、比で補正すると 0 時に戻ってしまう)。
   */
  const touched = useRef(false);

  // 前回の倍率を、端末から読み戻す(画面の上端の時刻が動かないよう、スクロール位置も合わせる)
  useEffect(() => {
    let cancelled = false;
    void getMeta(ZOOM_KEY)
      .then((v) => {
        const h = clampHourHeight(Number(v));
        if (cancelled || !Number.isFinite(h) || v === null || h === hourHeightRef.current) return;
        pendingScroll.current = touched.current
          ? (scrollY.current * h) / hourHeightRef.current
          : initialOffsetFor(h);
        setHourHeight(h);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 高さを変えた直後は、ScrollView の中身の高さがまだ古いことがあり、そこで scrollTo すると、
  // 新しい位置が古い高さに切り詰められてズレる。まずここで合わせ(多くはこれで足りる)、
  // 中身の高さが実際に変わったときの通知(onContentSizeChange)で、もう一度合わせて確定する。
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, pendingScroll.current), animated: false });
  }, [hourHeight]);
  const settleScroll = () => {
    if (pendingScroll.current === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, pendingScroll.current), animated: false });
    pendingScroll.current = null;
  };

  const touchDistance = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
  };
  const touchCenterY = (e: GestureResponderEvent) => {
    const [a, b] = e.nativeEvent.touches;
    return (a.pageY + b.pageY) / 2;
  };
  const measureTop = () => wrapRef.current?.measureInWindow((_x, y) => (pinchBase.current.top = y));

  const pinch = useRef(
    PanResponder.create({
      // 2 本指になったら、子のスクロール・予定のタップより先に奪う(予定を掴んでいる間は除く)
      onStartShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length === 2 && dragRef.current === null,
      onMoveShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length === 2 && dragRef.current === null,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        measureTop();
        const b = pinchBase.current;
        b.dist = Math.max(touchDistance(e), 1);
        b.h0 = hourHeightRef.current;
        // まだ触っていないなら、スクロール位置は初期位置のまま(scrollY は 0 のままなので使えない)
        b.y0 = touched.current ? scrollY.current : initialOffsetFor(hourHeightRef.current);
        touched.current = true;
        b.focal0 = touchCenterY(e) - b.top;
        setPinching(true);
      },
      onPanResponderMove: (e) => {
        if (e.nativeEvent.touches.length < 2) return;
        const b = pinchBase.current;
        const next = clampHourHeight((b.h0 * touchDistance(e)) / b.dist);
        if (next === hourHeightRef.current) return;
        // 指の中心の下にある時刻が、動かないように、スクロール位置を合わせる
        const focal = touchCenterY(e) - b.top;
        pendingScroll.current = ((b.y0 + b.focal0) * next) / b.h0 - focal;
        setHourHeight(next);
      },
      onPanResponderRelease: () => endPinch(),
      onPanResponderTerminate: () => endPinch(),
    }),
  ).current;

  const endPinch = () => {
    setPinching(false);
    void setMeta(ZOOM_KEY, String(hourHeightRef.current)).catch(() => undefined);
  };

  // ---- ドラッグ(長押しで予定を掴む) ----
  const [drag, setDrag] = useState<DragState | null>(null);
  /** 保存の応答待ちの間、動かした後の位置を出し続けるための値(完了で外す)。 */
  const [pending, setPending] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const latest = useRef<DragState | null>(null);
  // PanResponder は一度だけ作るので、最新の値は ref 越しに読む
  const live = useRef({ days, dayCount, timeZone, onMove, hourHeight, colW });
  live.current = { days, dayCount, timeZone, onMove, hourHeight, colW };

  const dayIndexOf = (ms: number) =>
    live.current.days.findIndex(
      (d) =>
        ms >= dayStartMs(d, live.current.timeZone) &&
        ms < dayStartMs(d.add({ days: 1 }), live.current.timeZone),
    );

  /** 掴んだ位置からの移動量 (dx, dy) から、動かした後の開始・終了を求める。 */
  const compute = (base: DragState, dx: number, dy: number): DragState => {
    const { days: ds, timeZone: tz, colW } = live.current;
    const deltaMs = Math.round((dy / live.current.hourHeight) * 60 / 15) * SNAP_MS;
    if (base.mode === "resize") {
      return { ...base, endMs: Math.max(base.startMs + SNAP_MS, base.endMs + deltaMs) };
    }
    const from = dayIndexOf(base.startMs);
    let dayDelta = 0;
    if (from >= 0 && colW > 0) {
      const to = Math.min(ds.length - 1, Math.max(0, from + Math.round(dx / colW)));
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

  // 現在時刻(1 分ごと、前面に戻ったときにも更新)。「今」を示す線に使う
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, 60_000);
    const sub = AppState.addEventListener("change", (st) => st === "active" && tick());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);

  // 最初に見せる位置。開いたときだけ決める(倍率の読み戻しでも、触るまでは同じ基準で作り直す)
  const [initialOffset] = useState(() => initialOffsetFor(hourHeight));

  // 表示する範囲全体で、予定の展開を 1 回だけ行い、日に振り分ける(日ごとに展開し直さない。ピンチでは展開し直さない)
  const byDay = useMemo(() => occurrencesByDay(data, days, timeZone), [data, days, timeZone]);
  const columns = useMemo(() => {
    const headerWindowMs = (HEADER_WINDOW_PX / hourHeight) * HOUR_MS;
    // 重なる予定のずれ。割合(7%)だけだと、列が狭い(表示日数が多い)とき数ピクセルになって、下の予定の
    // 濃い線(左端の色の線)が隠れる。ピクセルで下限を持つ(割合の上限は、予定が細くなりすぎない範囲)
    const indentFrac = Math.min(0.25, Math.max(STACK_INDENT_FRAC, MIN_STACK_INDENT_PX / colW));
    return days.map((date) => {
      const dayStart = dayStartMs(date, timeZone);
      const dayEnd = dayStartMs(date.add({ days: 1 }), timeZone);
      const dayOccurrences = byDay.get(date.toString()) ?? [];
      // 時刻付きの勤務場所。カードにはせず、列の左端の細い帯として出す
      const workingLocations = dayOccurrences.filter(
        (o) => o.isWorkingLocation === true && o.responseStatus !== "declined",
      );
      const items = dayOccurrences
        .filter((o) => !o.isWorkingLocation && o.responseStatus !== "declined")
        // 保存の応答待ちの予定は、動かした後の位置(別の日になることもある)で出す
        .filter((o) => !pending || o.id !== pending.o.id);
      if (pending && pending.startMs < dayEnd && pending.endMs > dayStart) {
        items.push({ ...pending.o, startMs: pending.startMs, endMs: pending.endMs });
      }
      // 不在は、他の予定の幅を奪わない背景の層として描く(全幅・最背面)。ただし、他の予定は、不在の
      // 左端が見えるように、右へ少し内側から配置する(oooInset)。完全に重なると、不在の存在が見えない。
      const slots = layoutOverlaps(
        items.map((o) => ({
          id: o.id,
          startMs: Math.max(o.startMs, dayStart),
          endMs: Math.min(o.endMs, dayEnd),
          background: o.isOutOfOffice === true,
        })),
        headerWindowMs,
        indentFrac,
      );
      // 不在の時間帯。他の予定は、これと時間が重なるときだけ、右へずらす(重ならない予定は、ずらさない)
      const oooRanges = items
        .filter((o) => o.isOutOfOffice === true)
        .map((o) => ({ startMs: o.startMs, endMs: o.endMs }));
      return { date, dayStart, dayEnd, items, oooRanges, workingLocations, slots, allDay: allDaysOnDate(data, date) };
    });
  }, [days, byDay, data, timeZone, pending, hourHeight, colW]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ marginLeft: GUTTER, overflow: "hidden" }}>
      <Animated.View
        style={{
          flexDirection: "row",
          width: colW * WINDOW_DAYS,
          transform: [{ translateX: scrollX.interpolate({ inputRange: [0, 1], outputRange: [0, -1] }) }],
        }}
      >
        {columns.map(({ date, allDay }) => {
          const isToday = date.equals(today);
          return (
            <View key={date.toString()} style={{ width: colW, alignItems: "center", paddingBottom: 4 }}>
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
              {/* 勤務場所の専用の行。他の終日予定に押し出されないよう、分けて出す */}
              {allDay.filter((a) => a.isWorkingLocation).slice(0, 1).map((a) => (
                <Pressable
                  key={a.id}
                  onPress={() => onSelect(a)}
                  style={{
                    alignSelf: "stretch",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 2,
                    marginHorizontal: 2,
                    marginTop: 2,
                    paddingHorizontal: 3,
                    borderRadius: 3,
                    backgroundColor: t.allDayBg(a.color),
                  }}
                >
                  <Icon name="mapPin" color={t.ink} size={11} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11, color: t.ink }}>
                    {a.title}
                  </Text>
                </Pressable>
              ))}
              {allDay.filter((a) => !a.isWorkingLocation).slice(0, 2).map((a) => (
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
      </Animated.View>
      </View>

      <View ref={wrapRef} style={{ flex: 1 }} onLayout={measureTop} {...pinch.panHandlers}>
      <Animated.ScrollView
        ref={scrollRef}
        contentOffset={{ x: 0, y: initialOffset }}
        onScrollBeginDrag={() => {
          touched.current = true;
        }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollAnim } } }], {
          useNativeDriver: true,
          listener: (e: { nativeEvent: { contentOffset: { y: number } } }) => {
            scrollY.current = e.nativeEvent.contentOffset.y;
          },
        })}
        scrollEventThrottle={16}
        onContentSizeChange={settleScroll}
        // 予定を掴んでいる間・ピンチの間は、スクロールさせない(指の動きを、予定の移動・拡大縮小に使うため)
        scrollEnabled={drag === null && !pinching}
        style={{ flex: 1, borderTopWidth: 1, borderTopColor: t.line }}
      >
        <View style={{ flexDirection: "row", height: 24 * hourHeight }} {...pan.panHandlers}>
          <View style={{ width: GUTTER }}>
            {Array.from({ length: 24 }, (_, h) => (
              <Text
                key={h}
                style={{
                  position: "absolute",
                  top: h * hourHeight - 7,
                  right: 6,
                  fontSize: 11,
                  color: t.inkSub,
                }}
              >
                {h === 0 ? "" : `${h}:00`}
              </Text>
            ))}
          </View>
          <Animated.ScrollView
            ref={hScrollRef}
            horizontal
            style={{ flex: 1 }}
            contentOffset={{ x: initialX, y: 0 }}
            // 1 列の幅で止まる。指で動かした分だけ、連続して動く(ページの切り替えではなく、巻き紙のように)
            snapToInterval={colW}
            decelerationRate="fast"
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], {
              useNativeDriver: true,
              listener: (e: { nativeEvent: { contentOffset: { x: number } } }) => {
                curX.current = e.nativeEvent.contentOffset.x;
              },
            })}
            onMomentumScrollEnd={(e) => settleX(e.nativeEvent.contentOffset.x)}
            // 予定を掴んでいる間・ピンチの間は、横にもスクロールさせない
            scrollEnabled={drag === null && !pinching}
          >
          <View style={{ width: colW * WINDOW_DAYS, height: 24 * hourHeight, flexDirection: "row" }}>
          {/* 時間の罫線は、帯全体で 1 組(日ごとには引かない) */}
          {Array.from({ length: 24 }, (_, h) => (
            <View
              key={h}
              pointerEvents="none"
              style={{ position: "absolute", top: h * hourHeight, left: 0, right: 0, height: 1, backgroundColor: t.lineWarm }}
            />
          ))}
          {columns.map(({ date, dayStart, dayEnd, items, oooRanges, workingLocations, slots }) => (
            <View
              key={date.toString()}
              style={{
                width: colW,
                borderLeftWidth: 1,
                borderLeftColor: t.line,
                // 今日の列は、デスクトップ版と同じく hoverTint をごく薄く敷く
                backgroundColor: date.equals(today) ? t.todayBg : undefined,
              }}
            >
              {/* 現在時刻の線(今日の列だけ)。予定の上に重ね、タップは素通しにする */}
              {nowMs >= dayStart && nowMs < dayEnd ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: ((nowMs - dayStart) / HOUR_MS) * hourHeight - 1,
                    left: 0,
                    right: 0,
                    height: 2,
                    backgroundColor: t.accent,
                    zIndex: 900,
                  }}
                >
                  <View
                    style={{
                      position: "absolute",
                      left: -4,
                      top: -3,
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: t.accent,
                    }}
                  />
                </View>
              ) : null}
              {workingLocations.map((o) => {
                const s = Math.max(o.startMs, dayStart);
                const e = Math.min(o.endMs, dayEnd);
                if (e <= s) return null;
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => onSelect(o)}
                    accessibilityLabel={`勤務場所 ${o.title}`}
                    style={{
                      position: "absolute",
                      left: 0,
                      width: WORKING_LOCATION_RAIL_PX,
                      top: ((s - dayStart) / 3_600_000) * hourHeight,
                      height: ((e - s) / 3_600_000) * hourHeight,
                      backgroundColor: o.color,
                      opacity: 0.7,
                      zIndex: 0,
                    }}
                  />
                );
              })}
              {items.map((o) => {
                const slot = slots.get(o.id);
                if (!slot) return null;
                const s = Math.max(o.startMs, dayStart);
                const e = Math.min(o.endMs, dayEnd);
                const top = ((s - dayStart) / 3_600_000) * hourHeight;
                const height = Math.max(((e - s) / 3_600_000) * hourHeight, 18);
                // タイトルの行数は、ブロックの高さに収まる分。ただし、長い予定は 3 行まで(残りの高さは、
                // タイトルが動ける余地にする: スクロールで上端が画面の外に出たら、タイトルを最上部へ寄せる)
                const lineH = (compact ? 12 : 14) * FONT_SCALE;
                const lines = Math.min(3, Math.max(1, Math.floor((height - 2) / lineH)));
                const stickyRange = Math.max(0, height - 3 - lines * lineH);
                // 不在と時間が重なる予定だけ、不在の左端が見えるように右へ内側から置く
                const oooInset =
                  !o.isOutOfOffice && oooRanges.some((r) => r.startMs < o.endMs && r.endMs > o.startMs)
                    ? MIN_STACK_INDENT_PX
                    : 0;
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
                      // 不在と重なる予定は、右へ oooInset だけ内側に置く(不在の左端を見せる)
                      left: o.isOutOfOffice || oooInset === 0 ? `${slot.leftFrac * 100}%` : oooInset + slot.leftFrac * (colW - oooInset),
                      width: o.isOutOfOffice || oooInset === 0 ? `${slot.widthFrac * 100}%` : slot.widthFrac * (colW - oooInset),
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
                    <Animated.View
                      style={
                        stickyRange > 4
                          ? {
                              transform: [
                                {
                                  translateY: scrollAnim.interpolate({
                                    inputRange: [top, top + stickyRange],
                                    outputRange: [0, stickyRange],
                                    extrapolate: "clamp",
                                  }),
                                },
                              ],
                            }
                          : undefined
                      }
                    >
                      <Text
                        // 行数は、ブロックの高さに収まる分だけ(狭い列で、1 文字ずつ折り返されて
                        // 縦に伸びすぎないように)。長い予定は 3 行まで。週表示は、列が狭いので文字も小さくする
                        numberOfLines={lines}
                        style={{ fontSize: compact ? 9.5 : 11, lineHeight: compact ? 12 : 14, color: t.ink }}
                      >
                        {o.isOutOfOffice ? `不在 ${o.title}` : o.title}
                      </Text>
                    </Animated.View>
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
              const top = ((drag.startMs - dayStartMs(days[idx], timeZone)) / HOUR_MS) * hourHeight;
              const height = Math.max(((drag.endMs - drag.startMs) / HOUR_MS) * hourHeight, 22);
              return (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: idx * colW + 1,
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
          </Animated.ScrollView>
        </View>
      </Animated.ScrollView>
      </View>
    </View>
  );
}
