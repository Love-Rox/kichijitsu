import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { CalendarScreen } from "../components/CalendarScreen";
import { getToken, signIn, signOut } from "../lib/auth";
import { loadCalendarData, type CalendarData } from "../lib/calendarData";

export default function Home() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "signedOut"; error?: string }
    | { kind: "ready"; data: CalendarData }
  >({ kind: "loading" });

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      if (!(await getToken())) return setState({ kind: "signedOut" });
      const data = await loadCalendarData();
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
      {state.kind === "loading" && <ActivityIndicator />}
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
