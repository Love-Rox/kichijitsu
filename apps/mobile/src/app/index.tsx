import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Button, Text, View } from "react-native";
import { CalendarScreen } from "../components/CalendarScreen";
import { getToken, signIn, signOut } from "../lib/auth";
import { clearAll } from "../lib/localDb";
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
   * 進行中の読み込みを中止するための AbortController。refresh とログアウトのたびに、前のものを中止する。
   * 中止された読み込みは、画面へも手元のデータベースへも何も書かない。これが無いと、ログアウト直後に
   * 古い読み込みが終わって、前のユーザーの予定が画面やデータベースに戻ってしまう。
   */
  const controller = useRef<AbortController | null>(null);
  /** 進行中の読み込みの完了を待つため(ログアウトが、書き込みの完了を待ってから全消去する)。 */
  const inflight = useRef<Promise<unknown> | null>(null);

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const mine = new AbortController();
    controller.current = mine;
    const isCurrent = () => !mine.signal.aborted;
    setState({ kind: "loading" });
    try {
      if (!(await getToken())) {
        // 未ログイン: 手元に予定が残っていれば消す(他人のものかもしれない)
        await clearAll();
        return isCurrent() && setState({ kind: "signedOut" });
      }
      // 手元のデータがあれば即座に表示し、同期できたカレンダーから順に反映する
      let latest: LoadProgress | null = null;
      const run = loadCalendarData({
        signal: mine.signal,
        onProgress: (progress) => {
          if (!isCurrent()) return;
          latest = progress;
          setState((s) =>
            s.kind === "ready" ? { ...s, syncing: progress } : { kind: "loading", progress },
          );
        },
        onPartial: (partial) => {
          if (isCurrent()) setState({ kind: "ready", data: partial, syncing: latest });
        },
      });
      inflight.current = run.catch(() => undefined);
      const data = await run;
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
      // ログインの前に、手元の予定を消す(別のユーザーのものを引き継がない)
      await clearAll();
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
            <CalendarScreen
              data={state.data}
              onChange={(update) =>
                setState((s) => (s.kind === "ready" ? { ...s, data: update(s.data) } : s))
              }
            />
          </View>
          <Button
            title="ログアウト"
            onPress={async () => {
              // 進行中の読み込みを中止してから、保存済みの予定とセッションを消す
              controller.current?.abort();
              // 進行中の書き込みが終わるのを待ってから消す(待たないと、消した後に書き込みが残りうる)。
              // 消去で失敗しても、セッションは必ず捨てる。
              await inflight.current;
              try {
                await clearAll();
              } finally {
                await signOut();
              }
              await refresh();
            }}
          />
        </>
      )}
      <StatusBar style="auto" />
    </View>
  );
}
