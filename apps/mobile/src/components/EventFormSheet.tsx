import { useTheme } from "../theme";
import DateTimePicker from "@react-native-community/datetimepicker";
import type { OutOfOfficeAutoDecline } from "@kichijitsu/shared";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { Text, TextInput } from "./ui";
import {
  DEFAULT_AUTO_DECLINE,
  resolveDefaultWriteTarget,
  writeTargetKey,
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


/** 作成先の候補 (WriteTargetCandidate + 表示名)。 */
export type FormTarget = WriteTargetCandidate & { label: string };

const DECLINE_OPTIONS: { value: OutOfOfficeAutoDecline; label: string }[] = [
  { value: "declineOnlyNewConflictingInvitations", label: "新しい招待だけ辞退する" },
  { value: "declineAllConflictingInvitations", label: "既存の予定も含めて辞退する" },
  { value: "declineNone", label: "辞退しない" },
];

/** 予定の作成フォーム (下から出るシート)。種別(予定/不在)・日時・場所・説明・カレンダーを入力できる。 */
export function EventFormSheet({
  visible,
  mode,
  initialDraft,
  canToggleAllDay,
  timeZone,
  targets: allTargets,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** 作成か編集か。編集では種別とカレンダーは変えられない(Google でも移動は別の操作)。 */
  mode: "create" | "edit";
  initialDraft: EventCreateDraft;
  /** 終日への切り替えを出すか(繰り返しの1回分は終日にできない)。作成では常に出す。 */
  canToggleAllDay: boolean;
  timeZone: string;
  /** 作成先の候補(書き込める表示中のカレンダー。複数アカウントぶん)。label は表示名。 */
  targets: FormTarget[];
  onClose: () => void;
  /**
   * 保存の実行。作成は「シートをすぐ閉じて楽観的に反映」なので、呼び出し側が閉じて何も返さない。
   * 編集は「保存ボタン方式」: Promise を返すと、成功するまでシートを開いたまま「保存中…」を出し、
   * 失敗したらここにエラーを出して再試行できる。
   */
  onSubmit: (draft: EventCreateDraft, target: WriteTargetCandidate | null) => void | Promise<void>;
}) {
  const t = useTheme();
  const isEdit = mode === "edit";
  const targets = allTargets;

  // シートを開くたびに作り直す(key で初期化する想定 — 呼び出し側が visible 切り替えで再マウントする)
  const [draft, setDraft] = useState<EventCreateDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  // 作成先は「アカウント + カレンダー」の組(別のアカウントに同じ id のカレンダーがありうる)
  const [targetKey, setTargetKey] = useState<string>(() => {
    const t = resolveDefaultWriteTarget(targets);
    return t ? writeTargetKey(t) : "";
  });
  const [error, setError] = useState<string | null>(null);

  const isOoo = draft.eventType === "outOfOffice";
  // 不在は Google の制約で、メインのカレンダーにだけ作れる
  const choices = isOoo ? targets.filter((t) => t.primary) : targets;
  const target = choices.find((t) => writeTargetKey(t) === targetKey) ?? choices[0] ?? null;

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
      // 不在は、メインのカレンダーにだけ作れる。選択中が違うなら、最初のメインのカレンダーへ寄せる
      const primary = targets.find((t) => t.primary);
      if (primary && !(target?.primary)) setTargetKey(writeTargetKey(primary));
    }
  };

  const submit = async () => {
    if (saving) return;
    const message = validateEventEditDraft(draft);
    if (message) return setError(message);
    if (!isEdit && !target) return setError("書き込めるカレンダーがありません");
    setError(null);
    setSaving(true);
    try {
      await onSubmit(draft, isEdit ? null : target);
    } catch (e) {
      // 適用範囲の問いかけをキャンセルしたのは失敗ではない(フォームを開いたまま、何も出さない)
      if ((e as Error)?.name !== "EditScopeCancelledError") {
        setError("保存できませんでした。もう一度お試しください。");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ flex: 1, padding: 20, backgroundColor: t.bg }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ fontSize: 15, color: t.inkMute }}>キャンセル</Text>
            </Pressable>
            <Text style={{ flex: 1, textAlign: "center", fontWeight: "700" }}>
              {isEdit ? "予定を編集" : "予定を作成"}
            </Text>
            <Pressable onPress={() => void submit()} hitSlop={10} disabled={saving}>
              <Text style={{ fontSize: 15, color: t.accent, fontWeight: "700" }}>
                {saving ? "保存中…" : isEdit ? "保存" : "作成"}
              </Text>
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <TextInput
              value={draft.title}
              onChangeText={(title) => set({ title })}
              placeholder={isOoo ? "不在のタイトル" : "予定のタイトル"}
              style={{ fontSize: 20, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}
              autoFocus={!isEdit}
            />

            {!isEdit && (
            <Row label="種別">
              <View style={{ flexDirection: "row", borderRadius: 6, borderWidth: 1, borderColor: t.line, overflow: "hidden" }}>
                {([["default", "予定"], ["outOfOffice", "不在"]] as const).map(([k, label]) => (
                  <Pressable
                    key={k}
                    onPress={() => setKind(k)}
                    style={{ paddingHorizontal: 14, paddingVertical: 5, backgroundColor: (isOoo ? "outOfOffice" : "default") === k ? t.accent : undefined }}
                  >
                    <Text style={{ color: (isOoo ? "outOfOffice" : "default") === k ? t.onAccent : t.inkMute }}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </Row>
            )}

            {!isOoo && (!isEdit || canToggleAllDay) && (
              <Row label="終日">
                <Switch value={draft.isAllDay} onValueChange={setAllDay} trackColor={{ true: t.accent }} />
              </Row>
            )}

            {draft.isAllDay ? (
              <>
                <Row label="開始日">
                  <DateTimePicker
                    themeVariant={t.scheme}
                    accentColor={t.accent}
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
                    themeVariant={t.scheme}
                    accentColor={t.accent}
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
                    themeVariant={t.scheme}
                    accentColor={t.accent}
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
                    themeVariant={t.scheme}
                    accentColor={t.accent}
                    mode="datetime"
                    display="compact"
                    locale="ja-JP"
                    value={new Date(draft.endMs)}
                    onChange={(_, d) => d && set({ endMs: d.getTime() })}
                  />
                </Row>
              </>
            )}

            {isOoo && !isEdit && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 12, color: t.inkSub, marginBottom: 4 }}>招待の自動辞退</Text>
                {DECLINE_OPTIONS.map((o) => {
                  const selected = (draft.autoDecline ?? DEFAULT_AUTO_DECLINE) === o.value;
                  return (
                    <Pressable
                      key={o.value}
                      onPress={() => set({ autoDecline: o.value })}
                      style={{ paddingVertical: 6, flexDirection: "row", gap: 8 }}
                    >
                      <Text style={{ color: selected ? t.accent : t.inkSub }}>{selected ? "●" : "○"}</Text>
                      <Text>{o.label}</Text>
                    </Pressable>
                  );
                })}
                {(draft.autoDecline ?? DEFAULT_AUTO_DECLINE) !== "declineNone" && (
                  <TextInput
                    value={draft.declineMessage ?? ""}
                    onChangeText={(declineMessage) => set({ declineMessage })}
                    placeholder="辞退メッセージ(任意)"
                    style={{ marginTop: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.line }}
                  />
                )}
                <Text style={{ fontSize: 11, color: t.inkSub, marginTop: 6 }}>
                  不在は、Google Workspace(職場・学校)アカウントのメインのカレンダーにだけ作れます(Google の仕様)。個人の Gmail では作れません。終日にもできません。
                </Text>
              </View>
            )}

            <TextInput
              value={draft.location}
              onChangeText={(location) => set({ location })}
              placeholder="場所"
              style={{ marginTop: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.line }}
            />
            <TextInput
              value={draft.description}
              onChangeText={(description) => set({ description })}
              placeholder="説明"
              multiline
              style={{ marginTop: 6, paddingVertical: 8, minHeight: 60, borderBottomWidth: 1, borderBottomColor: t.line }}
            />

            {!isEdit && choices.length > 1 && (
              <View style={{ marginTop: 14 }}>
                <Text style={{ fontSize: 12, color: t.inkSub, marginBottom: 4 }}>カレンダー</Text>
                {choices.map((cand) => {
                  const selected = target !== null && writeTargetKey(target) === writeTargetKey(cand);
                  return (
                    <Pressable
                      key={writeTargetKey(cand)}
                      onPress={() => setTargetKey(writeTargetKey(cand))}
                      style={{ paddingVertical: 6, flexDirection: "row", gap: 8, alignItems: "center" }}
                    >
                      <Text style={{ color: selected ? t.accent : t.inkSub }}>{selected ? "●" : "○"}</Text>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: cand.defaultColor }} />
                      <Text>{cand.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {error && <Text style={{ color: t.accent, marginTop: 12 }}>{error}</Text>}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 }}>
      <Text style={{ color: t.inkMute }}>{label}</Text>
      {children}
    </View>
  );
}
