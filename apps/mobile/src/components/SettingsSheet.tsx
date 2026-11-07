import * as Application from "expo-application";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, View } from "react-native";
import { writeTargetKey } from "@kichijitsu/web/sync/eventCreate";
import type { AccountCalendars, CalendarData } from "../lib/calendarData";
import { LEAD_OPTIONS, type NotifySettings } from "../lib/notifications";
import { useTheme } from "../theme";
import { Text } from "./ui";
import { Icon } from "./Icon";
import { ThemePanel } from "./ThemePanel";
import { ACCENTS, APPEARANCES } from "../lib/accents";
import { useThemePrefs } from "../lib/themePrefs";

/**
 * 設定メニュー(下から出るシート)。アカウントごとのカレンダーの表示/非表示、新しい予定の
 * 既定のカレンダー、ログアウト。ログアウトは、常に画面に出さず、ここにだけ置く。
 */
export function SettingsSheet({
  visible,
  data,
  defaultKey,
  onClose,
  onToggleCalendar,
  onSetDefault,
  notify,
  onChangeNotify,
  onSignOut,
  onForceSync,
}: {
  visible: boolean;
  data: CalendarData | null;
  /** 既定のカレンダー(writeTargetKey 形式)。null は自動(メインのカレンダー)。 */
  defaultKey: string | null;
  onClose: () => void;
  /** 表示/非表示の切り替え(サーバーへ保存)。失敗したら例外を投げる。 */
  onToggleCalendar: (account: AccountCalendars, calendarId: string, visible: boolean) => Promise<void>;
  onSetDefault: (key: string | null) => void;
  /** 予定の開始通知の設定。 */
  notify: NotifySettings;
  onChangeNotify: (next: NotifySettings) => void;
  onSignOut: () => void;
  /** 強制同期: 全カレンダーを、Google から取り直す(シートを閉じて、画面の同期表示に任せる)。 */
  onForceSync: () => void;
}) {
  const t = useTheme();
  const themePrefs = useThemePrefs();
  /** シートの中の画面: 設定の一覧 / カラーテーマ */
  const [page, setPage] = useState<"main" | "theme">("main");
  // 切り替えの途中(サーバーの応答前)の見た目。応答が来たら、再読み込みされたデータに任せる
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = async (a: AccountCalendars, id: string, next: boolean) => {
    const key = `${a.accountId}:${id}`;
    setPending((p) => ({ ...p, [key]: next }));
    try {
      await onToggleCalendar(a, id, next);
    } catch (e) {
      Alert.alert("変更できませんでした", String(e));
    } finally {
      setPending((p) => {
        const { [key]: _drop, ...rest } = p;
        return rest;
      });
    }
  };

  const confirmSignOut = () =>
    Alert.alert("ログアウトしますか?", "この端末に保存した予定も消えます。", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "ログアウト",
        style: "destructive",
        onPress: () => {
          onClose();
          onSignOut();
        },
      },
    ]);

  const writable = (data?.accounts ?? []).flatMap((a) =>
    a.calendars
      .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
      .map((c) => ({ a, c, key: writeTargetKey({ accountId: a.accountId, calendarId: c.id }) })),
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, padding: 20, backgroundColor: t.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
          {page === "theme" ? (
            <Pressable onPress={() => setPage("main")} hitSlop={10} style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 2 }}>
              <Icon name="caretLeft" color={t.accent} size={20} />
              <Text style={{ fontSize: 20, fontWeight: "700" }}>カラーテーマ</Text>
            </Pressable>
          ) : (
            <Text style={{ flex: 1, fontSize: 20, fontWeight: "700" }}>設定</Text>
          )}
          <Pressable
            onPress={() => {
              setPage("main");
              onClose();
            }}
            hitSlop={10}
          >
            <Text style={{ color: t.accent, fontSize: 15, fontWeight: "700" }}>完了</Text>
          </Pressable>
        </View>

        <ScrollView>
          {page === "theme" ? (
            <ThemePanel />
          ) : (
            <>
          <Pressable
            onPress={() => setPage("theme")}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, marginBottom: 14, gap: 8 }}
          >
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: t.accent }} />
            <Text style={{ flex: 1 }}>カラーテーマ</Text>
            <Text style={{ fontSize: 13, color: t.inkSub }}>
              {APPEARANCES.find((o) => o.key === themePrefs.appearance)?.label} ・ {ACCENTS[themePrefs.accent].label}
            </Text>
            <Icon name="caretRight" color={t.inkSub} size={16} />
          </Pressable>
          {(data?.accounts ?? []).map((a) => {
            const all = a.all ?? a.calendars;
            const shown = new Set(a.calendars.map((c) => c.id));
            const mine = all.filter((c) => c.accessRole === "owner");
            const others = all.filter((c) => c.accessRole !== "owner");
            return (
              <View key={a.accountId} style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>{a.email}</Text>
                {[
                  ["マイカレンダー", mine],
                  ["その他のカレンダー", others],
                ].map(([label, list]) =>
                  (list as typeof all).length === 0 ? null : (
                    <View key={label as string}>
                      <Text style={{ fontSize: 12, color: t.inkMute, marginTop: 6 }}>{label as string}</Text>
                      {(list as typeof all).map((c) => {
                        const key = `${a.accountId}:${c.id}`;
                        const on = key in pending ? pending[key] : shown.has(c.id);
                        return (
                          <View
                            key={c.id}
                            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7, gap: 10 }}
                          >
                            <View
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 4,
                                backgroundColor: c.backgroundColor ?? t.busyFallback,
                              }}
                            />
                            <Text style={{ flex: 1 }} numberOfLines={1}>
                              {c.summary}
                            </Text>
                            <Switch
                              value={on}
                              onValueChange={(next) => void toggle(a, c.id, next)}
                              trackColor={{ true: t.accent }}
                            />
                          </View>
                        );
                      })}
                    </View>
                  ),
                )}
              </View>
            );
          })}

          <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>
            新しい予定の作成先(既定のカレンダー)
          </Text>
          {[{ key: null as string | null, label: "自動(メインのカレンダー)", color: undefined as string | undefined }, ...writable.map(({ a, c, key }) => ({
            key: key as string | null,
            label: (data?.accounts.length ?? 0) > 1 ? `${c.summary} (${a.email})` : c.summary,
            color: c.backgroundColor,
          }))].map((opt) => {
            const selected = (defaultKey ?? null) === opt.key;
            return (
              <Pressable
                key={opt.key ?? "auto"}
                onPress={() => onSetDefault(opt.key)}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7, gap: 10 }}
              >
                <Icon name={selected ? "radioOn" : "radioOff"} color={selected ? t.accent : t.inkSub} size={20} />
                {opt.color ? (
                  <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: opt.color }} />
                ) : null}
                <Text style={{ flex: 1 }} numberOfLines={1}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}

          <Text style={{ fontSize: 13, color: t.inkSub, marginTop: 24, marginBottom: 6 }}>通知</Text>
          <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7 }}>
            <Text style={{ flex: 1 }}>予定の開始を通知する</Text>
            <Switch
              value={notify.enabled}
              onValueChange={(on) => onChangeNotify({ ...notify, enabled: on })}
              trackColor={{ true: t.accent }}
            />
          </View>
          {notify.enabled ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
              {(["google", ...LEAD_OPTIONS] as const).map((m) => {
                const on = notify.lead === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => onChangeNotify({ ...notify, lead: m })}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: on ? t.accent : t.line,
                      backgroundColor: on ? t.accent : undefined,
                    }}
                  >
                    <Text style={{ color: on ? t.onAccent : t.inkMute }}>{m === "google" ? "予定の設定に従う" : m === 0 ? "開始時刻" : `${m} 分前`}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {notify.enabled && notify.lead === "google" ? (
            <Text style={{ marginTop: 8, fontSize: 12, color: t.inkSub }}>
              Google カレンダーで、予定ごと(無ければカレンダーごと)に設定した通知の時刻に合わせます。通知を設定していない予定には出ません。
            </Text>
          ) : null}

          <Text style={{ fontSize: 13, color: t.inkSub, marginTop: 24, marginBottom: 6 }}>同期</Text>
          <Pressable
            onPress={onForceSync}
            disabled={data === null}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 8, opacity: data === null ? 0.4 : 1 }}
          >
            <Text style={{ color: t.accent, fontSize: 15 }}>今すぐ強制同期</Text>
          </Pressable>
          <Text style={{ fontSize: 12, color: t.inkSub }}>
            予定が合わないときに、すべてのカレンダーを Google から取り直します(通常の同期は、変更分だけを取ります)。
          </Text>

          <Pressable onPress={confirmSignOut} style={{ marginTop: 32, alignSelf: "flex-start" }}>
            <Text style={{ color: t.accent, fontSize: 15 }}>ログアウト</Text>
          </Pressable>

          {/* 入っているビルドの確認用(TestFlight の表示と突き合わせる)。実際にインストールされたアプリの値 */}
          <Text style={{ marginTop: 28, fontSize: 12, color: t.inkSub }} selectable>
            kichijitsu {Application.nativeApplicationVersion ?? "?"} ({Application.nativeBuildVersion ?? "?"})
          </Text>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
