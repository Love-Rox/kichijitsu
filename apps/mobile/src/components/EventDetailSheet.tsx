import { Temporal } from "@js-temporal/polyfill";
import { Alert, Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { GuestNotify } from "@kichijitsu/web/sync/guestNotify";
import { formatDay, formatTime, stripHtml } from "../lib/format";
import { asksGuestNotify, canDelete, isTimed, type EventSubject } from "../lib/mutations";

const ACCENT = "#c13625";

/** 予定の詳細(下から出るシート)。削除はここから。 */
export function EventDetailSheet({
  subject,
  timeZone,
  onClose,
  onEdit,
  onDelete,
}: {
  subject: EventSubject | null;
  timeZone: string;
  onClose: () => void;
  /** 編集フォームを開く。 */
  onEdit: (subject: EventSubject) => void;
  /** 削除の実行。失敗したら例外を投げる(シートの側でエラーを知らせる)。 */
  onDelete: (subject: EventSubject, notify: GuestNotify | undefined) => Promise<void>;
}) {
  const run = async (s: EventSubject, notify: GuestNotify | undefined) => {
    onClose();
    try {
      await onDelete(s, notify);
    } catch (e) {
      Alert.alert("削除できませんでした", "もう一度お試しください。\n" + String(e));
    }
  };

  const confirmDelete = (s: EventSubject) => {
    if (asksGuestNotify(s)) {
      Alert.alert("予定を削除", "ゲストに削除を通知しますか?", [
        { text: "キャンセル", style: "cancel" },
        { text: "通知せず削除", onPress: () => void run(s, "externalOnly") },
        { text: "通知して削除", style: "destructive", onPress: () => void run(s, "all") },
      ]);
    } else {
      Alert.alert("予定を削除しますか?", s.title, [
        { text: "キャンセル", style: "cancel" },
        { text: "削除", style: "destructive", onPress: () => void run(s, undefined) },
      ]);
    }
  };

  const when = subject ? whenLabel(subject, timeZone) : "";
  const description = subject?.description ? stripHtml(subject.description) : "";
  const url = subject?.link?.url;

  return (
    <Modal
      visible={subject !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {subject && (
        <View style={{ flex: 1, padding: 20 }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ fontSize: 15, color: ACCENT }}>閉じる</Text>
            </Pressable>
          </View>
          <ScrollView>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ width: 5, borderRadius: 3, backgroundColor: subject.color }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 22, fontWeight: "700" }}>{subject.title}</Text>
                <Text style={{ marginTop: 6, color: "#555" }}>{when}</Text>
              </View>
            </View>
            {subject.location ? (
              <Text style={{ marginTop: 14, color: "#333" }}>場所: {subject.location}</Text>
            ) : null}
            {description ? (
              <Text style={{ marginTop: 14, color: "#333", lineHeight: 20 }}>{description}</Text>
            ) : null}
            {url && /^https?:\/\//.test(url) ? (
              <Pressable onPress={() => void Linking.openURL(url)} style={{ marginTop: 18 }}>
                <Text style={{ color: ACCENT }}>Google カレンダーで開く</Text>
              </Pressable>
            ) : null}
            {canDelete(subject) ? (
              <View style={{ marginTop: 28, flexDirection: "row", gap: 28 }}>
                <Pressable onPress={() => onEdit(subject)}>
                  <Text style={{ color: ACCENT, fontSize: 15 }}>編集</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(subject)}>
                  <Text style={{ color: ACCENT, fontSize: 15 }}>削除</Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        </View>
      )}
    </Modal>
  );
}

function whenLabel(s: EventSubject, timeZone: string): string {
  if (isTimed(s)) {
    const sameDay =
      formatDay(s.startMs, timeZone) === formatDay(s.endMs - 1, timeZone);
    return sameDay
      ? `${formatDay(s.startMs, timeZone)} ${formatTime(s.startMs, timeZone)}–${formatTime(s.endMs, timeZone)}`
      : `${formatDay(s.startMs, timeZone)} ${formatTime(s.startMs, timeZone)} – ${formatDay(s.endMs, timeZone)} ${formatTime(s.endMs, timeZone)}`;
  }
  const start = Temporal.PlainDate.from(s.startDate);
  const end = Temporal.PlainDate.from(s.endDate);
  const fmt = (d: Temporal.PlainDate) => `${d.month}月${d.day}日`;
  return start.equals(end) ? `${fmt(start)} 終日` : `${fmt(start)} – ${fmt(end)} 終日`;
}
