import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, TextInput, View } from "react-native";
import { currentPlace, getWeatherPlace, saveWeatherPlace, searchPlaces, type WeatherPlace } from "../lib/weatherPlace";
import { useTheme } from "../theme";
import { Text } from "./ui";

/** 設定シートの中の「天気の場所」の画面: 地名で探す / 現在地を使う / 解除。選ぶとすぐ保存され、ウィジェットに届く。 */
export function WeatherPlacePanel({ onChanged }: { onChanged?: (place: WeatherPlace | null) => void }) {
  const t = useTheme();
  const [place, setPlace] = useState<WeatherPlace | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherPlace[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getWeatherPlace().then(setPlace);
  }, []);

  const choose = async (next: WeatherPlace | null) => {
    await saveWeatherPlace(next);
    setPlace(next);
    setResults(null);
    setQuery("");
    onChanged?.(next);
  };

  const search = async () => {
    setBusy(true);
    try {
      setResults(await searchPlaces(query));
    } catch {
      Alert.alert("探せませんでした", "通信を確かめて、もう一度試してください。");
    } finally {
      setBusy(false);
    }
  };

  const useHere = async () => {
    setBusy(true);
    try {
      const p = await currentPlace();
      if (p) await choose(p);
      else Alert.alert("位置情報が許可されていません", "設定アプリで許可するか、地名で探してください。");
    } catch {
      Alert.alert("現在地を取れませんでした", "地名で探すこともできます。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>いまの場所</Text>
      <Text style={{ fontSize: 17, marginBottom: 4 }}>
        {place ? (place.followsCurrent ? `現在地(${place.name})` : place.name) : "未設定"}
      </Text>
      <Text style={{ fontSize: 12, color: t.inkSub, marginBottom: 18 }}>
        ウィジェットの天気に使います。未設定のあいだは、天気は出ません。
      </Text>

      <Pressable onPress={useHere} disabled={busy} style={{ paddingVertical: 10, opacity: busy ? 0.4 : 1 }}>
        <Text style={{ color: t.accent, fontSize: 15 }}>現在地を常に使う</Text>
      </Pressable>
      <Text style={{ fontSize: 12, color: t.inkSub, marginBottom: 18 }}>
        ウィジェットが、表示のたびに最新の現在地の天気を出します。位置情報の許可は「使用中のみ」で足ります(アプリの許可を、ウィジェットも使います)。現在地が取れないときは、最後に取れた場所を使います。
      </Text>

      <Text style={{ fontSize: 13, color: t.inkSub, marginBottom: 6 }}>地名で探す</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={search}
          placeholder="例: 渋谷、札幌駅、福岡市"
          placeholderTextColor={t.inkSub}
          returnKeyType="search"
          style={{
            flex: 1,
            color: t.ink,
            borderWidth: 1,
            borderColor: t.inkSub,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            fontSize: 15,
          }}
        />
        <Pressable onPress={search} disabled={busy || !query.trim()} style={{ opacity: busy || !query.trim() ? 0.4 : 1 }}>
          <Text style={{ color: t.accent, fontSize: 15, fontWeight: "700" }}>探す</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator style={{ marginTop: 12 }} /> : null}
      {results !== null && !busy ? (
        results.length === 0 ? (
          <Text style={{ marginTop: 12, color: t.inkSub }}>見つかりませんでした。</Text>
        ) : (
          results.map((r) => (
            <Pressable key={`${r.latitude},${r.longitude}`} onPress={() => choose(r)} style={{ paddingVertical: 10 }}>
              <Text style={{ fontSize: 15 }}>{r.name}</Text>
            </Pressable>
          ))
        )
      ) : null}

      {place ? (
        <Pressable onPress={() => choose(null)} style={{ marginTop: 22, alignSelf: "flex-start" }}>
          <Text style={{ color: t.accent, fontSize: 15 }}>場所を解除する</Text>
        </Pressable>
      ) : null}

      <Pressable onPress={() => Linking.openURL("https://weatherkit.apple.com/legal-attribution.html")} style={{ marginTop: 28 }}>
        <Text style={{ fontSize: 12, color: t.inkSub }}>Apple Weather ・ 他のデータ提供元</Text>
      </Pressable>
    </View>
  );
}
