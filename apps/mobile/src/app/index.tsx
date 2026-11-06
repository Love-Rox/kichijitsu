import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { CalendarScreen } from "../components/CalendarScreen";
import { getToken, signIn, signOut } from "../lib/auth";
import { loadCalendarData, type CalendarData, type LoadProgress } from "../lib/calendarData";

function loadingLabel(p?: LoadProgress): string {
  if (!p || p.phase === "account") return "アカウントを確認しています…";
  if (p.phase === "calendars") return "カレンダーの一覧を取得しています…";
  return `予定を読み込んでいます… (${p.done}/${p.total} カレンダー)`;
}

export default function Home() {
  const [state, setState] = useState<
    | { kind: "loading"; progress?: LoadProgress }
    | { kind: "signedOut"; error?: string }
    | { kind: "ready"; data: CalendarData }
  >({ kind: "loading" });

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      if (!(await getToken())) return setState({ kind: "signedOut" });
      const data = await loadCalendarData((progress) => setState({ kind: "loading", progress }));
      setState(data ? { kind: "ready", data } : { kind: "signedOut" });
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
      <Text style={{ fontSize: 20, fontWeight: "700", marginBottom: 4 }}>kichijitsu</Text>
      {state.kind === "loading" && (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <ActivityIndicator size="large" />
          <Text style={{ color: "#555" }}>{loadingLabel(state.progress)}</Text>
          {state.progress?.phase === "sync" && state.progress.total > 0 && (
            <View style={{ width: 200, height: 4, borderRadius: 2, backgroundColor: "#eee" }}>
              <View
                style={{
                  width: `${(state.progress.done / state.progress.total) * 100}%`,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: "#c13625",
                }}
              />
            </View>
          )}
        </View>
      )}
      {state.kind === "signedOut" && (
        <View style={{ gap: 12 }}>
          {state.error && <Text style={{ color: "#c13625" }}>{state.error}</Text>}
          <Button title="Google でログイン" onPress={onSignIn} />
        </View>
      )}
      {state.kind === "ready" && (
        <>
          <View style={{ flex: 1 }}>
            <CalendarScreen data={state.data} />
          </View>
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
