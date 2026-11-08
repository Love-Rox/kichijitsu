import SwiftUI
import WidgetKit

// 文字盤のコンプリケーション。Watch アプリが Watch 側の App Group に書いた予定を読む。
// データの形式は iPhone 側のウィジェットと同じ("events" キーに JSON 文字列)。
private let appGroup = "group.cc.love-rox.kichijitsu"
private let defaultAccent = Color(red: 0xEA / 255, green: 0x64 / 255, blue: 0x51 / 255)

private struct ThemePayload: Decodable { let light: String; let dark: String }

private func parseHex(_ hex: String?) -> Color? {
    guard let s = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), s.count == 6,
          let v = UInt32(s, radix: 16) else { return nil }
    return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

private func accent() -> Color {
    guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: "theme"),
          let data = raw.data(using: .utf8),
          let theme = try? JSONDecoder().decode(ThemePayload.self, from: data) else { return defaultAccent }
    return parseHex(theme.dark) ?? defaultAccent
}

struct ComplicationEvent: Decodable {
    let title: String
    let startMs: Double
    let endMs: Double
    let color: String?   // カレンダーの色("#RRGGBB")。古いデータには無い
    var start: Date { Date(timeIntervalSince1970: startMs / 1000) }
    var end: Date { Date(timeIntervalSince1970: endMs / 1000) }
}

private struct Payload: Decodable { let events: [ComplicationEvent] }

private func loadEvents() -> [ComplicationEvent] {
    guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: "events"),
          let data = raw.data(using: .utf8),
          let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return [] }
    return payload.events.sorted { $0.start < $1.start }
}

struct Entry: TimelineEntry {
    let date: Date
    let events: [ComplicationEvent]   // date の時点で、終わっていない予定(開始順)
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), events: []) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), events: loadEvents().filter { $0.end > Date() }))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date()
        let all = loadEvents()
        // 予定の開始・終了の時刻ごとに表示を切り替える(最大 20 本)
        var times = Set<Date>([now])
        for e in all where e.end > now { times.insert(max(e.start, now)); times.insert(e.end) }
        let sorted = times.filter { $0 >= now }.sorted().prefix(20)
        let entries = sorted.map { t in Entry(date: t, events: all.filter { $0.end > t }) }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
    }
}

private let timeFormat: Date.FormatStyle = .dateTime.hour().minute()

/// 小さい枠に出す時刻。これから始まる予定は開始時刻、進行中の予定は「〜終了時刻」
private func clockText(_ e: ComplicationEvent, at date: Date) -> String {
    date >= e.start ? "〜\(e.end.formatted(timeFormat))" : e.start.formatted(timeFormat)
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.widgetRenderingMode) var renderingMode
    let entry: Entry

    /// カレンダーの色。フルカラーの文字盤だけで使う(単色の文字盤では、システムが 1 色に染める)
    private func tint(_ e: ComplicationEvent) -> Color? {
        renderingMode == .fullColor ? parseHex(e.color) : nil
    }

    var body: some View {
        let next = entry.events.first
        switch family {
        case .accessoryCircular:
            // 小さい丸: 次の予定の時刻(進行中なら、終わる時刻)と、題名の頭の数文字
            ZStack {
                AccessoryWidgetBackground()
                if let e = next {
                    VStack(spacing: 0) {
                        Text(clockText(e, at: entry.date)).font(.system(size: 15, weight: .semibold)).minimumScaleFactor(0.6).lineLimit(1)
                        Text(e.title).font(.system(size: 9)).lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .padding(.horizontal, 4)
                    .foregroundStyle(tint(e) ?? Color.primary)
                } else {
                    Image(systemName: "calendar")
                }
            }
            .widgetAccentable()
        case .accessoryCorner:
            // 角: 内側は 2 行。上に時刻、下に「開始」か「終了」。題名は外周のラベルに。内側は幅が
            // 狭く(GMT の文字盤など)、「〜10:30」を 1 行では入れられなかったので、2 行に分ける
            if let e = next {
                let started = entry.date >= e.start
                VStack(spacing: 0) {
                    Text((started ? e.end : e.start).formatted(timeFormat))
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    Text(started ? "終了" : "開始")
                        .font(.system(size: 10))
                        .lineLimit(1)
                }
                .foregroundStyle(tint(e) ?? Color.primary)
                .widgetLabel { Text(e.title) }
                .widgetAccentable()
            } else {
                Image(systemName: "calendar")
                    .widgetLabel { Text("予定なし") }
            }
        case .accessoryInline:
            if let e = next {
                Text("\(e.start.formatted(timeFormat)) \(e.title)")
            } else {
                Text("予定なし")
            }
        default:
            VStack(alignment: .leading, spacing: 2) {
                if entry.events.isEmpty {
                    Text("予定はありません").font(.system(size: 14, weight: .semibold))
                } else {
                    ForEach(Array(entry.events.prefix(2).enumerated()), id: \.offset) { _, e in
                        // 左に、カレンダーの色の縦棒(単色の文字盤では、システムの色になる)
                        HStack(spacing: 5) {
                            RoundedRectangle(cornerRadius: 1.5)
                                .fill(tint(e) ?? Color.primary)
                                .frame(width: 3)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(e.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                Text("\(e.start.formatted(timeFormat))–\(e.end.formatted(timeFormat))")
                                    .font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetAccentable()
        }
    }
}

@main
struct KichijitsuWatchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuWatchWidget", provider: Provider()) { entry in
            ComplicationView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("次の予定")
        .description("これからの予定を文字盤に表示します。")
        .supportedFamilies([.accessoryRectangular, .accessoryInline, .accessoryCircular, .accessoryCorner])
    }
}
