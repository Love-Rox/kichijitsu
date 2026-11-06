import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Button, FlatList, Text, View } from "react-native";
import type {
  CalendarListEntryDTO,
  GoogleEventDTO,
  MeResponse,
  SyncResponse,
} from "@kichijitsu/shared";
import { apiFetch } from "../lib/api";
import { getToken, signIn, signOut } from "../lib/auth";

/**
 * スパイク画面: ログイン → 連携アカウントの primary カレンダーの予定(単発・時刻つき)を、
 * 開始の近い順に並べるだけ。ログインとデータ取得の経路が成立するかの確認が目的で、
 * 見た目や繰り返し予定の展開はまだ扱わない。
 */
interface Row {
  id: string;
  title: string;
  startMs: number;
}

const DEVICE_ID = "mobile-spike";

async function loadUpcoming(): Promise<{ email: string; rows: Row[] } | null> {
  const me = await apiFetch<MeResponse>("/api/me");
  if (!me || !me.connected || me.accounts.length === 0) return null;
  const account = me.accounts[0];

  const calendars = await apiFetch<CalendarListEntryDTO[]>(
    `/api/calendars?accountId=${encodeURIComponent(account.id)}`,
  );
  const primary = calendars?.find((c) => c.primary) ?? calendars?.[0];
  if (!primary) return { email: account.email, rows: [] };

  const sync = await apiFetch<SyncResponse>("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      accountId: account.id,
      calendarId: primary.id,
      deviceId: DEVICE_ID,
      forceFull: true,
    }),
  });
  const now = Date.now();
  const rows = (sync?.events ?? [])
    .filter((e: GoogleEventDTO) => e.status !== "cancelled" && e.start?.dateTime)
    .map((e) => ({
      id: e.id,
      title: e.summary ?? "(タイトルなし)",
      startMs: Date.parse(e.start!.dateTime!),
    }))
    .filter((r) => r.startMs >= now)
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, 30);
  return { email: account.email, rows };
}

export default function Home() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "signedOut"; error?: string }
    | { kind: "ready"; email: string; rows: Row[] }
  >({ kind: "loading" });

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      if (!(await getToken())) return setState({ kind: "signedOut" });
      const result = await loadUpcoming();
      setState(result ? { kind: "ready", ...result } : { kind: "signedOut" });
    } catch (e) {
      setState({ kind: "signedOut", error: String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSignIn = async () => {
    try {
      if (await signIn()) await refresh();
    } catch (e) {
      setState({ kind: "signedOut", error: String(e) });
    }
  };

  return (
    <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
      <Text style={{ fontSize: 24, fontWeight: "700", marginBottom: 12 }}>kichijitsu</Text>
      {state.kind === "loading" && <ActivityIndicator />}
      {state.kind === "signedOut" && (
        <View style={{ gap: 12 }}>
          {state.error && <Text style={{ color: "#c13625" }}>{state.error}</Text>}
          <Button title="Google でログイン" onPress={onSignIn} />
        </View>
      )}
      {state.kind === "ready" && (
        <>
          <Text style={{ marginBottom: 8 }}>{state.email}</Text>
          <FlatList
            data={state.rows}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => (
              <View style={{ paddingVertical: 8 }}>
                <Text style={{ fontSize: 12, color: "#666" }}>
                  {new Date(item.startMs).toLocaleString("ja-JP")}
                </Text>
                <Text style={{ fontSize: 16 }}>{item.title}</Text>
              </View>
            )}
            ListEmptyComponent={<Text>これからの予定はありません</Text>}
          />
          <Button
            title="ログアウト"
            onPress={async () => {
              await signOut();
              await refresh();
            }}
          />
        </>
      )}
      <StatusBar style="auto" />
    </View>
  );
}
