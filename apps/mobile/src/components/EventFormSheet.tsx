import DateTimePicker from "@react-native-community/datetimepicker";
import type { CalendarListEntryDTO, OutOfOfficeAutoDecline } from "@kichijitsu/shared";
import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  buildCreateDraft,
  DEFAULT_AUTO_DECLINE,
  resolveDefaultWriteTarget,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "@kichijitsu/web/sync/eventCreate";
import {
  dateValueToExclusiveEndMs,
  dateValueToMs,
  msExclusiveToDateValue,
  msToDateValue,
  validateEventEditDraft,
} from "@kichijitsu/web/sync/eventEdit";

const ACCENT = "#c13625";

const DECLINE_OPTIONS: { value: OutOfOfficeAutoDecline; label: string }[] = [
  { value: "declineOnlyNewConflictingInvitations", label: "新しい招待だけ辞退する" },
  { value: "declineAllConflictingInvitations", label: "既存の予定も含めて辞退する" },
  { value: "declineNone", label: "辞退しない" },
];

/** 予定の作成フォーム (下から出るシート)。種別(予定/不在)・日時・場所・説明・カレンダーを入力できる。 */
export function EventFormSheet({
  visible,
  initialStartMs,
  timeZone,
  accountId,
  calendars,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** 開始の初期値 (epoch ms)。終了は +1 時間。 */
  initialStartMs: number;
  timeZone: string;
  accountId: string;
  calendars: CalendarListEntryDTO[];
  onClose: () => void;
  /** 作成の実行。シートはすぐ閉じ、失敗は呼び出し側が知らせる。 */
  onSubmit: (draft: EventCreateDraft, target: WriteTargetCandidate) => void;
}) {
  // 書き込めるカレンダーだけ(オーナー/編集者)。祝日や購読などの読み取り専用は出さない
  const targets = useMemo<WriteTargetCandidate[]>(
    () =>
      calendars
        .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
        .map((c) => ({
          accountId,
          calendarId: c.id,
          primary: c.primary,
          defaultColor: c.backgroundColor,
        })),
    [calendars, accountId],
  );
  const nameOf = (calendarId: string) =>
    calendars.find((c) => c.id === calendarId)?.summary ?? calendarId;

  // シートを開くたびに作り直す(key で初期化する想定 — 呼び出し側が visible 切り替えで再マウントする)
  const [draft, setDraft] = useState<EventCreateDraft>(() =>
    buildCreateDraft(initialStartMs, initialStartMs + 3_600_000),
  );
  const [calendarId, setCalendarId] = useState<string>(
    () => resolveDefaultWriteTarget(targets)?.calendarId ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const isOoo = draft.eventType === "outOfOffice";
  // 不在は Google の制約で、メインのカレンダーにだけ作れる
  const choices = isOoo ? targets.filter((t) => t.primary) : targets;
  const target = choices.find((t) => t.calendarId === calendarId) ?? choices[0] ?? null;

  const set = (patch: Partial<EventCreateDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const setAllDay = (next: boolean) => {
    if (next === draft.isAllDay) return;
    if (next) {
      const date = msToDateValue(draft.startMs, timeZone);
      set({
        isAllDay: true,
        startMs: dateValueToMs(date, timeZone),
        endMs: dateValueToExclusiveEndMs(date, timeZone),
      });
    } else {
      const date = msToDateValue(draft.startMs, timeZone);
      const start = dateValueToMs(date, timeZone) + 9 * 3_600_000;
      set({ isAllDay: false, startMs: start, endMs: start + 3_600_000 });
    }
  };

  const setKind = (kind: "default" | "outOfOffice") => {
    if (kind === "outOfOffice" && draft.isAllDay) setAllDay(false);
    set({
      eventType: kind,
      autoDecline: draft.autoDecline ?? DEFAULT_AUTO_DECLINE,
    });
    if (kind === "outOfOffice") {
      const primary = targets.find((t) => t.primary);
      if (primary) setCalendarId(primary.calendarId);
    }
  };

  const submit = () => {
    const message = validateEventEditDraft(draft);
    if (message) return setError(message);
    if (!target) return setError("書き込めるカレンダーがありません");
    onSubmit(draft, target);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ flex: 1, padding: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ fontSize: 15, color: "#555" }}>キャンセル</Text>
            </Pressable>
            <Text style={{ flex: 1, textAlign: "center", fontWeight: "700" }}>予定を作成</Text>
            <Pressable onPress={submit} hitSlop={10}>
              <Text style={{ fontSize: 15, color: ACCENT, fontWeight: "700" }}>作成</Text>
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <TextInput
              value={draft.title}
              onChangeText={(title) => set({ title })}
              placeholder={isOoo ? "不在のタイトル" : "予定のタイトル"}
              style={{ fontSize: 20, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#ddd" }}
              autoFocus
            />

            <Row label="種別">
              <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: "#ddd", overflow: "hidden" }}>
                {([["default", "予定"], ["outOfOffice", "不在"]] as const).map(([k, label]) => (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    style={{ paddingHorizontal: 14, paddingVertical: 5, backgroundColor: (isOoo ? "outOfOffice" : "default") === k ? ACCENT : undefined }}
                  >
                    <Text style={{ color: (isOoo ? "outOfOffice" : "default") === k ? "#fff" : "#555" }}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </Row>

            {!isOoo && (
              <Row label="終日">
                <Switch value={draft.isAllDay} onValueChange={setAllDay} trackColor={{ true: ACCENT }} />
              </Row>
            )}

            {draft.isAllDay ? (
              <>
                <Row label="開始日">
                  <DateTimePicker
                    mode="date"
                    display="compact"
                    locale="ja-JP"
                    value={new Date(draft.startMs)}
                    onChange={(_, d) => {
                      if (!d) return;
                      const start = dateValueToMs(msToDateValue(d.getTime(), timeZone), timeZone);
                      const endDate = msExclusiveToDateValue(draft.endMs, timeZone);
                      set({
                        startMs: start,
                        endMs: Math.max(dateValueToExclusiveEndMs(endDate, timeZone), start + 86_400_000),
                      });
                    }}
                  />
                </Row>
                <Row label="終了日">
                  <DateTimePicker
                    mode="date"
                    display="compact"
                    locale="ja-JP"
                    value={new Date(draft.endMs - 1)}
                    onChange={(_, d) => {
                      if (!d) return;
                      set({
                        endMs: dateValueToExclusiveEndMs(msToDateValue(d.getTime(), timeZone), timeZone),
                      });
                    }}
                  />
                </Row>
              </>
            ) : (
              <>
                <Row label="開始">
                  <DateTimePicker
                    mode="datetime"
                    display="compact"
                    locale="ja-JP"
                    value={new Date(draft.startMs)}
                    onChange={(_, d) => {
                      if (!d) return;
                      // 開始を動かしたら、長さを保って終了も動かす
                      const length = draft.endMs - draft.startMs;
                      set({ startMs: d.getTime(), endMs: d.getTime() + length });
                    }}
                  />
                </Row>
                <Row label="終了">
                  <DateTimePicker
                    mode="datetime"
                    display="compact"
                    locale="ja-JP"
                    value={new Date(draft.endMs)}
                    onChange={(_, d) => d && set({ endMs: d.getTime() })}
                  />
                </Row>
              </>
            )}

            {isOoo && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>招待の自動辞退</Text>
                {DECLINE_OPTIONS.map((o) => {
                  const selected = (draft.autoDecline ?? DEFAULT_AUTO_DECLINE) === o.value;
                  return (
                    <Pressable
                      key={o.value}
                      onPress={() => set({ autoDecline: o.value })}
                      style={{ paddingVertical: 6, flexDirection: "row", gap: 8 }}
                    >
                      <Text style={{ color: selected ? ACCENT : "#999" }}>{selected ? "●" : "○"}</Text>
                      <Text>{o.label}</Text>
                    </Pressable>
                  );
                })}
                {(draft.autoDecline ?? DEFAULT_AUTO_DECLINE) !== "declineNone" && (
                  <TextInput
                    value={draft.declineMessage ?? ""}
                    onChangeText={(declineMessage) => set({ declineMessage })}
                    placeholder="辞退メッセージ(任意)"
                    style={{ marginTop: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#ddd" }}
                  />
                )}
                <Text style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
                  不在はメインのカレンダーにだけ作れます。終日にはできません。
                </Text>
              </View>
            )}

            <TextInput
              value={draft.location}
              onChangeText={(location) => set({ location })}
              placeholder="場所"
              style={{ marginTop: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#ddd" }}
            />
            <TextInput
              value={draft.description}
              onChangeText={(description) => set({ description })}
              placeholder="説明"
              multiline
              style={{ marginTop: 6, paddingVertical: 8, minHeight: 60, borderBottomWidth: 1, borderBottomColor: "#ddd" }}
            />

            {choices.length > 1 && (
              <View style={{ marginTop: 14 }}>
                <Text style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>カレンダー</Text>
                {choices.map((t) => {
                  const selected = target?.calendarId === t.calendarId;
                  return (
                    <Pressable
                      key={t.calendarId}
                      onPress={() => setCalendarId(t.calendarId)}
                      style={{ paddingVertical: 6, flexDirection: "row", gap: 8, alignItems: "center" }}
                    >
                      <Text style={{ color: selected ? ACCENT : "#999" }}>{selected ? "●" : "○"}</Text>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.defaultColor }} />
                      <Text>{nameOf(t.calendarId)}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {error && <Text style={{ color: ACCENT, marginTop: 12 }}>{error}</Text>}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 }}>
      <Text style={{ color: "#555" }}>{label}</Text>
      {children}
    </View>
  );
}
