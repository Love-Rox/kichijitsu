import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
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
    | { kind: "ready"; data: CalendarData; syncing: LoadProgress | null }
  >({ kind: "loading" });

  /**
   * 読み込みの世代番号。refresh とログアウトのたびに進める。進行中の古い読み込み
   * (onProgress / onPartial / 最終結果 / エラー) は、世代が古ければ画面へ反映せず捨てる。
   * これが無いと、ログアウト直後に古い読み込みが終わって、前のユーザーの予定が
   * 画面に戻ってきてしまう。
   */
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const isCurrent = () => generation.current === mine;
    setState({ kind: "loading" });
    try {
      if (!(await getToken())) return isCurrent() && setState({ kind: "signedOut" });
      // 最初のカレンダーが読めた時点で画面を出し、残りは表示したまま順に反映する
      let latest: LoadProgress | null = null;
      const data = await loadCalendarData(
        (progress) => {
          if (!isCurrent()) return;
          latest = progress;
          setState((s) =>
            s.kind === "ready" ? { ...s, syncing: progress } : { kind: "loading", progress },
          );
        },
        (partial) => {
          if (isCurrent()) setState({ kind: "ready", data: partial, syncing: latest });
        },
      );
      if (!isCurrent()) return;
      setState(data ? { kind: "ready", data, syncing: null } : { kind: "signedOut" });
    } catch (e) {
      if (isCurrent()) setState({ kind: "signedOut", error: String(e) });
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
          {state.syncing && state.syncing.total > 0 && state.syncing.done < state.syncing.total && (
            <View style={{ marginBottom: 4 }}>
              <Text style={{ fontSize: 11, color: "#888" }}>
                同期しています… ({state.syncing.done}/{state.syncing.total})
              </Text>
              <View style={{ height: 2, backgroundColor: "#eee" }}>
                <View
                  style={{
                    height: 2,
                    width: `${(state.syncing.done / state.syncing.total) * 100}%`,
                    backgroundColor: "#c13625",
                  }}
                />
              </View>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <CalendarScreen data={state.data} />
          </View>
          <Button
            title="ログアウト"
            onPress={async () => {
              // 進行中の読み込みの結果を捨ててから、セッションを消す
              generation.current += 1;
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
