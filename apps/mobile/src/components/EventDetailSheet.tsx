import { useTheme } from "../theme";
import { Temporal } from "@js-temporal/polyfill";
import { useState } from "react";
import { Alert, Linking, Modal, Pressable, ScrollView, View } from "react-native";
import type { RsvpResponseStatus } from "@kichijitsu/shared";
import { Text } from "./ui";
import {
  detectMeetingProvider,
  meetingLocationLabel,
  meetingProviderLabel,
  resolveMeetingUrl,
} from "@kichijitsu/web/layout/meetingLinks";
import {
  buildGuestListView,
  GUEST_PREVIEW_COUNT,
  GUEST_STATUS_LABEL,
} from "@kichijitsu/web/layout/guestList";
import type { GuestNotify } from "@kichijitsu/web/sync/guestNotify";
import { formatDay, formatTime, stripHtml } from "../lib/format";
import { asksGuestNotify, canDelete, isTimed, type EventSubject } from "../lib/mutations";


/** 予定の詳細(下から出るシート)。削除はここから。 */
export function EventDetailSheet({
  subject,
  timeZone,
  onClose,
  onEdit,
  onDelete,
  onRsvp,
}: {
  subject: EventSubject | null;
  timeZone: string;
  onClose: () => void;
  /** 編集フォームを開く。 */
  onEdit: (subject: EventSubject) => void;
  /** 削除の実行。失敗したら例外を投げる(シートの側でエラーを知らせる)。 */
  onDelete: (subject: EventSubject, notify: GuestNotify | undefined) => Promise<void>;
  /** 自分の出欠の変更。反映後の予定を返す(押したボタンの状態をすぐ見せるため)。失敗したら例外。 */
  onRsvp: (subject: EventSubject, status: RsvpResponseStatus) => Promise<EventSubject>;
}) {
  const t = useTheme();
  // 出欠を変えた後の予定。開いている予定と同じものなら、こちらを表示に使う
  const [updated, setUpdated] = useState<EventSubject | null>(null);
  const [showAllGuests, setShowAllGuests] = useState(false);
  const [rsvpBusy, setRsvpBusy] = useState(false);
  const view = subject && updated && updated.id === subject.id ? updated : subject;

  const changeRsvp = async (status: RsvpResponseStatus) => {
    if (!view || rsvpBusy || view.responseStatus === status) return;
    setRsvpBusy(true);
    try {
      setUpdated(await onRsvp(view, status));
    } catch (e) {
      Alert.alert("返信できませんでした", String((e as Error).message ?? e));
    } finally {
      setRsvpBusy(false);
    }
  };
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

  const when = view ? whenLabel(view, timeZone) : "";
  const description = view?.description ? stripHtml(view.description) : "";
  const url = view?.link?.url;
  // 会議リンク(Meet・Zoom・Teams・Slack ハドル)。ビデオ会議の URL、または場所に入った会議 URL。
  const meetingUrl = view ? resolveMeetingUrl(view.conferenceUrl, view.location) : undefined;
  const meetingLabel = meetingUrl
    ? (() => {
        const provider = detectMeetingProvider(meetingUrl);
        return provider ? meetingProviderLabel(provider) : "ビデオ会議";
      })()
    : undefined;
  const guests = view ? buildGuestListView(view.attendees, view.attendeesOmitted) : null;

  return (
    <Modal
      visible={subject !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {view && (
        <View style={{ flex: 1, padding: 20, backgroundColor: t.bg }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ fontSize: 15, color: t.accent }}>閉じる</Text>
            </Pressable>
          </View>
          <ScrollView>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ width: 5, borderRadius: 3, backgroundColor: view.color }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 22, fontWeight: "700" }}>{view.title}</Text>
                <Text style={{ marginTop: 6, color: t.inkMute }}>{when}</Text>
              </View>
            </View>
            {meetingUrl && /^https?:\/\//.test(meetingUrl) ? (
              <Pressable
                onPress={() => void Linking.openURL(meetingUrl)}
                style={{
                  marginTop: 16,
                  alignSelf: "flex-start",
                  paddingHorizontal: 16,
                  paddingVertical: 9,
                  borderRadius: 8,
                  backgroundColor: t.accent,
                }}
              >
                <Text style={{ color: t.onAccent, fontWeight: "700" }}>{meetingLabel} に参加</Text>
              </Pressable>
            ) : null}
            {view.location && view.location.trim() !== meetingUrl ? (
              <Text style={{ marginTop: 14, color: t.ink }}>
                場所: {meetingLocationLabel(view.location)}
              </Text>
            ) : null}
            {view.responseStatus !== undefined ? (
              <View style={{ marginTop: 18 }}>
                <Text style={{ fontSize: 12, color: t.inkSub, marginBottom: 6 }}>あなたの出欠</Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignSelf: "flex-start",
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: t.line,
                    overflow: "hidden",
                    opacity: rsvpBusy ? 0.5 : 1,
                  }}
                >
                  {(
                    [
                      ["accepted", "参加"],
                      ["tentative", "未定"],
                      ["declined", "不参加"],
                    ] as const
                  ).map(([status, label]) => (
                    <Pressable
                      key={status}
                      onPress={() => void changeRsvp(status)}
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                        backgroundColor: view.responseStatus === status ? t.accent : undefined,
                      }}
                    >
                      <Text
                        style={{ color: view.responseStatus === status ? t.onAccent : t.inkMute }}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
            {guests ? (
              <View style={{ marginTop: 20 }}>
                <Text style={{ fontWeight: "600" }}>{guests.countLabel}</Text>
                {guests.summaryLabel ? (
                  <Text style={{ fontSize: 12, color: t.inkSub, marginTop: 2 }}>{guests.summaryLabel}</Text>
                ) : null}
                {(showAllGuests ? guests.guests : guests.guests.slice(0, GUEST_PREVIEW_COUNT)).map((g) => (
                  <View key={g.key} style={{ paddingVertical: 6 }}>
                    <Text numberOfLines={1}>
                      {g.label}
                      {g.note ? `(${g.note})` : ""}
                    </Text>
                    <Text style={{ fontSize: 12, color: t.inkSub }} numberOfLines={1}>
                      {GUEST_STATUS_LABEL[g.responseStatus]}
                      {g.subLabel ? ` ・ ${g.subLabel}` : ""}
                    </Text>
                  </View>
                ))}
                {guests.guests.length > GUEST_PREVIEW_COUNT ? (
                  <Pressable onPress={() => setShowAllGuests((v) => !v)} style={{ paddingVertical: 6 }}>
                    <Text style={{ color: t.accent }}>
                      {showAllGuests ? "折りたたむ" : `他 ${guests.guests.length - GUEST_PREVIEW_COUNT} 人を表示`}
                    </Text>
                  </Pressable>
                ) : null}
                {guests.rooms.length > 0 ? (
                  <Text style={{ fontSize: 12, color: t.inkSub, marginTop: 4 }}>
                    会議室: {guests.rooms.join("、")}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {description ? (
              <Text style={{ marginTop: 14, color: t.ink, lineHeight: 20 }}>{description}</Text>
            ) : null}
            {url && /^https?:\/\//.test(url) ? (
              <Pressable onPress={() => void Linking.openURL(url)} style={{ marginTop: 18 }}>
                <Text style={{ color: t.accent }}>Google カレンダーで開く</Text>
              </Pressable>
            ) : null}
            {canDelete(view) ? (
              <View style={{ marginTop: 28, flexDirection: "row", gap: 28 }}>
                <Pressable onPress={() => onEdit(view)}>
                  <Text style={{ color: t.accent, fontSize: 15 }}>編集</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(view)}>
                  <Text style={{ color: t.accent, fontSize: 15 }}>削除</Text>
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
