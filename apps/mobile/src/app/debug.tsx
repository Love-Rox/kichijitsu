import { ScrollView, Text, View } from "react-native";
import { runTemporalChecks } from "../lib/temporalCheck";

/** 開発用: Hermes での Temporal の動作検証結果を出す。 */
export default function Debug() {
  const results = runTemporalChecks();
  return (
    <ScrollView style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
      <Text style={{ fontSize: 20, fontWeight: "700", marginBottom: 8 }}>Temporal 検証</Text>
      {results.map((r) => (
        <View key={r.name} style={{ marginBottom: 10 }}>
          <Text style={{ color: r.ok ? "#1a7f37" : "#c13625", fontWeight: "600" }}>
            {r.ok ? "OK" : "NG"} {r.name}
          </Text>
          <Text style={{ fontSize: 12, color: "#555" }}>{r.detail}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
