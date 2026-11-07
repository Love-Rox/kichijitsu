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

struct ComplicationView: View {
    @Environment(\.widgetFamily) var family
    let entry: Entry

    var body: some View {
        let next = entry.events.first
        switch family {
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
                        VStack(alignment: .leading, spacing: 0) {
                            Text(e.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            Text("\(e.start.formatted(timeFormat))–\(e.end.formatted(timeFormat))")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
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
        .supportedFamilies([.accessoryRectangular, .accessoryInline])
    }
}
