import { useTheme } from "../theme";
import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ActivityIndicator, Alert, Animated, PanResponder, Pressable, View } from "react-native";
import { Text } from "./ui";
import { Icon } from "./Icon";
import type { CalendarData } from "../lib/calendarData";
import { dayStartMs } from "@kichijitsu/web/layout/dayTime";
import {
  buildCreateDraft,
} from "@kichijitsu/web/sync/eventCreate";
import { draftFromAllDayOccurrence, draftFromOccurrence } from "@kichijitsu/web/sync/eventEdit";
import { isSeriesInstance, type RecurrenceScope } from "@kichijitsu/web/sync/recurrenceScope";
import {
  createEvent,
  deleteEvent,
  isTimed,
  rsvp,
  editGuests,
  setEventColor,
  addEventMeet,
  saveEdit,
  type ApplyChange,
  type AskScope,
  type EventSubject,
} from "../lib/mutations";
import { EventDetailSheet } from "./EventDetailSheet";
import { SearchSheet } from "./SearchSheet";
import { EventFormSheet, type FormTarget } from "./EventFormSheet";
import { MonthAgenda } from "./MonthAgenda";
import { mondayOf } from "@kichijitsu/web/layout/monthGrid";
import { Timeline } from "./Timeline";

type ViewKind = "day" | "3day" | "week" | "month";
const VIEWS: [ViewKind, string][] = [
  ["day", "日"],
  ["3day", "3日"],
  ["week", "週"],
  ["month", "月"],
];
/** タイムライン系のビューが一度に出す日数。 */
const DAY_COUNT: Record<Exclude<ViewKind, "month">, number> = { day: 1, "3day": 3, week: 7 };

const SCOPE_LABELS: Record<RecurrenceScope, string> = { this: "この予定のみ", all: "すべての予定" };

/** 編集の保存で、適用範囲とゲストへの通知を Alert で訊く。キャンセルは null。 */
const askScope: AskScope = ({ title, scopes, askNotify }) =>
  new Promise((resolve) => {
    const askNotifyStep = (scope: RecurrenceScope) => {
      if (!askNotify) return resolve({ scope, notify: undefined });
      Alert.alert("ゲストに通知しますか?", title, [
        { text: "キャンセル", style: "cancel", onPress: () => resolve(null) },
        { text: "通知しない", onPress: () => resolve({ scope, notify: "externalOnly" }) },
        { text: "通知する", onPress: () => resolve({ scope, notify: "all" }) },
      ]);
    };
    if (scopes.length === 0) return askNotifyStep("this");
    Alert.alert("繰り返しの予定を変更", title, [
      { text: "キャンセル", style: "cancel", onPress: () => resolve(null) },
      ...scopes.map((scope) => ({ text: SCOPE_LABELS[scope], onPress: () => askNotifyStep(scope) })),
    ]);
  });

/** ログイン後のメイン画面。3日表示と月表示を、共通のヘッダー(移動・今日・切り替え)で切り替える。 */
export function CalendarScreen({
  data,
  defaultTargetKey,
  onChange,
}: {
  data: CalendarData;
  /** 新しい予定の作成先の既定のカレンダー (writeTargetKey 形式)。null は自動。 */
  defaultTargetKey: string | null;
  /** 楽観的な変更を画面のデータへ反映する(保存は変更の側で行う)。 */
  onChange: ApplyChange;
}) {
  const t = useTheme();
  const timeZone = useMemo(() => Temporal.Now.timeZoneId(), []);
  const today = useMemo(() => Temporal.Now.plainDateISO(timeZone), [timeZone]);
  const [view, setView] = useState<ViewKind>("3day");
  // 表示の基準日。日・3日では先頭日、週ではその週(月曜始まり)、月では表示中の月を決める。
  // 月表示では、これとは別に、選んだ日 (selected) を持つ
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [detail, setDetail] = useState<EventSubject | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // 作成先の候補: 書き込める(オーナー/編集者)表示中のカレンダー。祝日や購読などの読み取り専用は出さない。
  // アカウントが複数あるときは、表示名にメールアドレスを添える。
  const formTargets = useMemo<FormTarget[]>(
    () =>
      data.accounts.flatMap((a) =>
        a.calendars
          .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
          .map((c) => ({
            accountId: a.accountId,
            calendarId: c.id,
            primary: c.primary,
            defaultColor: c.backgroundColor,
            label: data.accounts.length > 1 ? `${c.summary} (${a.email})` : c.summary,
          })),
      ),
    [data.accounts],
  );

  /** 作成/編集フォームの状態 (null = 閉じている)。 */
  const [form, setForm] = useState<
    { mode: "create"; startMs: number } | { mode: "edit"; subject: EventSubject } | null
  >(null);

  /** 作成の初期の開始: 表示中の日が今日なら次の正時、それ以外ならその日の 9 時。 */
  const openForm = () => {
    // タイムライン系は、今日が表示範囲に入っていれば今日、なければ先頭日。月表示は、選んだ日
    const day =
      view === "month"
        ? selected
        : (() => {
            const offset = timelineStart.until(today).days;
            return offset >= 0 && offset < DAY_COUNT[view] ? today : timelineStart;
          })();
    const now = Date.now();
    const start = day.equals(today)
      ? Math.ceil(now / 3_600_000) * 3_600_000
      : dayStartMs(day, timeZone) + 9 * 3_600_000;
    setForm({ mode: "create", startMs: start });
  };

  // タイムラインの先頭日: 週は、基準日を含む週の月曜
  const timelineStart = view === "week" ? mondayOf(anchor) : anchor;

  // ---- 切り替え中の表示 ----
  // 表示の切り替え・移動では、予定の展開と描画で、一瞬 JS が止まる。押した直後に「反応している」ことが
  // 分かるよう、(1) 押したボタンをすぐ選択状態にし、(2) 読み込み中の表示を出してから、重い再描画を
  // 低い優先度 (transition) で行う。再描画が終わったら(表示が変わったら)表示を外す。
  const [, startTransition] = useTransition();
  const [pendingView, setPendingView] = useState<ViewKind | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBusy(false);
    setPendingView(null);
  }, [view, anchor, selected]);
  /** 状態の変更を、「読み込み中」を先に出してから行う。 */
  const switching = (change: () => void) => {
    setBusy(true);
    startTransition(change);
  };

  const move = (dir: 1 | -1) => {
    switching(() =>
      setAnchor((a) => (view === "month" ? a.add({ months: dir }).with({ day: 1 }) : a.add({ days: DAY_COUNT[view] * dir }))),
    );
  };

  // ---- 横スワイプで、前後の期間へ移る(日・3日・週・月) ----
  // 指に合わせて内容が横に動き、一定以上動かして離すと、期間が切り替わる(「前へ/次へ」と同じ移動)。足りなければ元に戻る。
  // 切り替わるときは、いまの内容を横へ出し、(再描画のあと)新しい内容を反対側から入れる。
  const slideX = useRef(new Animated.Value(0)).current;
  const contentWidth = useRef(0);
  /** 切り替えの後に、新しい内容を入れる向き(1 = 次の期間 → 右から入る、-1 = 前、0 = 入れない) */
  const slideIn = useRef<0 | 1 | -1>(0);
  // 最新の状態は、PanResponder (一度だけ作る) から、ref 越しに読む
  const live = useRef({ move, busy });
  live.current = { move, busy };

  const swipe = useRef(
    PanResponder.create({
      // 横に大きく、縦より十分多く動いたときだけ奪う(縦スクロール・タップを邪魔しない)。
      // 予定の長押しドラッグ・2 本指のピンチは、Timeline の側が capture で先に奪うので、ここには来ない
      onMoveShouldSetPanResponder: (e, g) =>
        !live.current.busy &&
        e.nativeEvent.touches.length === 1 &&
        Math.abs(g.dx) > 14 &&
        Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => slideX.setValue(g.dx * 0.7), // 少し重く(指より控えめに動く)
      onPanResponderRelease: (_, g) => {
        const w = contentWidth.current || 360;
        const dir: 1 | -1 = g.dx < 0 ? 1 : -1; // 左へスワイプ = 次の期間
        const committed = Math.abs(g.dx) > Math.min(90, w * 0.25) || Math.abs(g.vx) > 0.5;
        if (!committed || live.current.busy) {
          Animated.spring(slideX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
          return;
        }
        Animated.timing(slideX, { toValue: -dir * w, duration: 130, useNativeDriver: true }).start(() => {
          slideIn.current = dir;
          live.current.move(dir);
        });
      },
      onPanResponderTerminate: () =>
        Animated.spring(slideX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
    }),
  ).current;
  // 切り替わった(再描画が終わった)ら、新しい内容を反対側から入れる
  useEffect(() => {
    if (slideIn.current === 0) return;
    const w = contentWidth.current || 360;
    slideX.setValue(slideIn.current * w);
    slideIn.current = 0;
    Animated.timing(slideX, { toValue: 0, duration: 180, useNativeDriver: true }).start();
  }, [view, anchor, selected, slideX]);
  /** ビューの切り替え。月表示で選んでいた日を、他のビューの基準日として引き継ぐ。 */
  const changeView = (next: ViewKind) => {
    if (next === view) return;
    setPendingView(next); // 押したボタンを、すぐ選択状態にする
    switching(() => {
      if (view === "month" && next !== "month") setAnchor(selected);
      if (view !== "month" && next === "month") {
        setAnchor(timelineStart);
        setSelected(timelineStart);
      }
      setView(next);
    });
  };
  const goToday = () => {
    if (anchor.equals(today) && selected.equals(today)) return;
    switching(() => {
      setAnchor(today);
      setSelected(today);
    });
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6, gap: 10 }}>
        <Pressable onPress={() => move(-1)} hitSlop={8} accessibilityLabel="前へ">
          <Icon name="caretLeft" color={t.ink} size={22} />
        </Pressable>
        <Pressable onPress={goToday} hitSlop={8}>
          <Text style={{ fontSize: 14, color: t.accent }}>今日</Text>
        </Pressable>
        <Pressable onPress={() => move(1)} hitSlop={8} accessibilityLabel="次へ">
          <Icon name="caretRight" color={t.ink} size={22} />
        </Pressable>
        <Text style={{ fontSize: 15, fontWeight: "600" }}>
          {timelineStart.year}年{timelineStart.month}月
        </Text>
        <Pressable onPress={() => setSearchOpen(true)} hitSlop={8} style={{ marginLeft: "auto" }} accessibilityLabel="検索">
          <Icon name="search" color={t.ink} size={22} />
        </Pressable>
        <Pressable onPress={openForm} hitSlop={8} accessibilityLabel="予定を作る">
          <Icon name="plus" color={t.accent} size={24} />
        </Pressable>
        <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: t.line, overflow: "hidden" }}>
          {VIEWS.map(([v, label]) => (
            <Pressable
              key={v}
              onPress={() => changeView(v)}
              style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: (pendingView ?? view) === v ? t.accent : undefined }}
            >
              <Text style={{ fontSize: 13, color: (pendingView ?? view) === v ? t.onAccent : t.inkMute }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Animated.View
        style={{ flex: 1, transform: [{ translateX: slideX }] }}
        onLayout={(e) => {
          contentWidth.current = e.nativeEvent.layout.width;
        }}
        {...swipe.panHandlers}
      >
      {view !== "month" ? (
        <Timeline
          data={data}
          start={timelineStart}
          dayCount={DAY_COUNT[view]}
          today={today}
          timeZone={timeZone}
          onSelect={setDetail}
          onMove={(o, startMs, endMs) =>
            // ドラッグでの移動は、編集フォームの保存と同じ経路(適用範囲・ゲストへの通知も訊く)
            saveEdit(
              o,
              { ...draftFromOccurrence(o), startMs, endMs },
              timeZone,
              onChange,
              data,
              askScope,
            ).catch((e: Error) => {
              // 適用範囲の問いかけのキャンセルは、失敗ではない(元の位置に戻るだけ)
              if (e.name === "EditScopeCancelledError") return;
              Alert.alert("移動できませんでした", String(e.message ?? e));
            })
          }
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

      {busy ? (
        // 切り替え中は、触れないようにして、読み込み中を見せる
        <View
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: `${t.bg}99`,
          }}
        >
          <ActivityIndicator size="large" color={t.accent} />
        </View>
      ) : null}
      </Animated.View>

      {form !== null && (
        <EventFormSheet
          key={form.mode === "edit" ? form.subject.id : "create"}
          visible
          mode={form.mode}
          initialDraft={
            form.mode === "create"
              ? buildCreateDraft(form.startMs, form.startMs + 3_600_000)
              : isTimed(form.subject)
                ? draftFromOccurrence(form.subject)
                : draftFromAllDayOccurrence(form.subject, timeZone)
          }
          // 繰り返しの1回分は終日にできない(Web 版と同じ)
          canToggleAllDay={form.mode === "create" || !isSeriesInstance(form.subject)}
          timeZone={timeZone}
          targets={formTargets}
          defaultTargetKey={defaultTargetKey}
          onClose={() => setForm(null)}
          onSubmit={(draft, target) => {
            if (form.mode === "create") {
              setForm(null);
              if (target) {
                createEvent(draft, target, timeZone, onChange)
                  .then((r) => {
                    if (r.meetFailed) {
                      Alert.alert(
                        "予定は作成しました",
                        "Meet は付けられませんでした。予定の詳細から、もう一度追加してください。",
                      );
                    }
                  })
                  .catch((e) =>
                  Alert.alert(
                    draft.eventType === "outOfOffice" ? "不在を作成できませんでした" : "作成できませんでした",
                    draft.eventType === "outOfOffice"
                      ? // Google は、不在を Workspace(エンタープライズ)のカレンダー以外には作らせない
                        // (個人の Gmail では 400 "can only be created on an enterprise calendar")
                        "不在は、Google Workspace(職場・学校)アカウントのメインのカレンダーにだけ作れます。" +
                        "個人の Gmail では作れません。"
                      : "もう一度お試しください。\n" + String(e),
                  ),
                );
              }
              return;
            }
            // 編集は保存ボタン方式: 成功するまでフォームを開いたままにし、失敗はフォームに出す
            return saveEdit(form.subject, draft, timeZone, onChange, data, askScope).then(() =>
              setForm(null),
            );
          }}
        />
      )}

      <SearchSheet
        visible={searchOpen}
        data={data}
        timeZone={timeZone}
        onClose={() => setSearchOpen(false)}
        onSelect={(subject) => {
          // 検索のシートを閉じてから詳細を開く(iOS は、モーダルを重ねて出せないことがある)
          setSearchOpen(false);
          setTimeout(() => setDetail(subject), 450);
        }}
      />
      <EventDetailSheet
        subject={detail}
        timeZone={timeZone}
        onClose={() => setDetail(null)}
        onEdit={(subject) => {
          setDetail(null);
          setForm({ mode: "edit", subject });
        }}
        onDelete={(subject, notify) => deleteEvent(subject, notify, onChange, data)}
        onRsvp={(subject, status) => rsvp(subject, status, onChange, data)}
        onEditGuests={(subject, change) => editGuests(subject, change, onChange)}
        onSetColor={(subject, colorId) => setEventColor(subject, colorId, onChange, data)}
        onAddMeet={(subject) => addEventMeet(subject, onChange)}
      />
    </View>
  );
}
