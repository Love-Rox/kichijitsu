import SwiftUI
import WidgetKit

// アプリ(JS)が App Group に書いた直近の予定を表示するウィジェット。
// データは UserDefaults(suiteName: group)の "events" キーに JSON 文字列で入っている:
//   { "updatedAt": <ms>, "events": [{ "title", "startMs", "endMs", "color" }] }
// ログアウトすると、アプリが "events" を消す(空のときは「予定はありません」)。
// アプリのカラーテーマのアクセント色は、"theme" キーに { "light": "#rrggbb", "dark": "#rrggbb" } で入っている
// (無ければ既定の朱)。ウィジェットの明暗は OS に従う(アプリ内の外観の上書きは、ここには届かない)。
let appGroup = "group.cc.love-rox.kichijitsu"
let defaultAccentLight = Color(red: 0xC1 / 255, green: 0x36 / 255, blue: 0x25 / 255)
let defaultAccentDark = Color(red: 0xEA / 255, green: 0x64 / 255, blue: 0x51 / 255)

struct ThemePayload: Decodable { let light: String; let dark: String }

func parseHex(_ hex: String?) -> Color? {
    guard let s = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), s.count == 6,
          let v = UInt32(s, radix: 16) else { return nil }
    return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

/// 今の明暗でのアクセント色(アプリで選んだ色。読めなければ既定の朱)。
func appAccent(_ scheme: ColorScheme) -> Color {
    let fallback = scheme == .dark ? defaultAccentDark : defaultAccentLight
    guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: "theme"),
          let data = raw.data(using: .utf8),
          let theme = try? JSONDecoder().decode(ThemePayload.self, from: data) else { return fallback }
    return parseHex(scheme == .dark ? theme.dark : theme.light) ?? fallback
}

/// 端末の言語設定(設定アプリの「言語と地域」の第 1 言語)。拡張機能の Locale.current は、アプリが持つ言語
/// (ローカライズ)に引きずられて、端末の設定と違う言語になることがあるので、設定そのものから作る。
let systemLocale: Locale = {
    let id = Locale.preferredLanguages.first ?? "ja-JP"
    // 「ja」だけで地域が無いときは、端末の地域を足す(日付の並び・曜日の書き方が、地域で変わるため)
    if Locale(identifier: id).region == nil, let region = Locale.current.region?.identifier {
        return Locale(identifier: "\(id)-\(region)")
    }
    return Locale(identifier: id)
}()

/// ウィジェットの日付の見せ方(アプリの設定。App Group の "dateFormat")。
/// system: 端末の言語・地域に従う / md: 月日と曜日 / num: 2026/11/10(火) / numShort: 11/10(火)
func formatDate(_ d: Date) -> String {
    let mode = UserDefaults(suiteName: appGroup)?.string(forKey: "dateFormat") ?? "system"
    let isJapanese = systemLocale.language.languageCode?.identifier == "ja"
    var cal = Calendar(identifier: .gregorian)
    cal.locale = systemLocale
    let weekday = d.formatted(.dateTime.weekday(.abbreviated).locale(systemLocale))
    let wrapped = isJapanese ? "(\(weekday))" : " \(weekday)"
    func numeric(_ pattern: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = pattern
        return f.string(from: d) + wrapped
    }
    switch mode {
    case "md": return d.formatted(.dateTime.month().day().weekday().locale(systemLocale))
    case "num": return numeric("yyyy/MM/dd")
    case "numShort": return numeric("M/d")
    default: return d.formatted(.dateTime.year().month().day().weekday().locale(systemLocale))
    }
}

struct WidgetEvent: Decodable, Identifiable {
    let title: String
    let startMs: Double
    let endMs: Double
    let color: String?
    /// 場所(アプリが送る。無い予定・古いデータでは nil)
    let location: String?
    var id: String { "\(startMs)-\(title)" }
    /// 一覧に出す場所(改行は空白に、空は nil)
    var place: String? {
        guard let loc = location?.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces),
              !loc.isEmpty else { return nil }
        return loc
    }
    var start: Date { Date(timeIntervalSince1970: startMs / 1000) }
    var end: Date { Date(timeIntervalSince1970: endMs / 1000) }
}

private struct Payload: Decodable { let events: [WidgetEvent] }

func loadEvents() -> [WidgetEvent] {
    guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: "events"),
          let data = raw.data(using: .utf8),
          let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return [] }
    return payload.events.sorted { $0.start < $1.start }
}

func hexColor(_ hex: String?, fallback: Color) -> Color { parseHex(hex) ?? fallback }

struct Entry: TimelineEntry {
    let date: Date
    let events: [WidgetEvent]   // date の時点で、終わっていない予定(開始順)
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date(), events: []) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), events: upcoming(at: Date())))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date()
        let all = loadEvents()
        // 予定の開始・終了の時刻ごとに表示を切り替える(最大 20 本)
        var times = Set<Date>([now])
        for e in all where e.end > now { times.insert(max(e.start, now)); times.insert(e.end) }
        let sorted = times.filter { $0 >= now }.sorted().prefix(20)
        let entries = sorted.map { t in Entry(date: t, events: all.filter { $0.end > t }) }
        // 最後のエントリ以降、または予定が無いときは、30 分後に読み直す
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
    }

    private func upcoming(at t: Date) -> [WidgetEvent] { loadEvents().filter { $0.end > t } }
}

let timeFormat: Date.FormatStyle = .dateTime.hour().minute()

/// 「10:00–11:00 ・ 会議室 A」。場所が無ければ時刻だけ。
func timeAndPlace(_ time: String, _ place: String?) -> String {
    place.map { "\(time) ・ \($0)" } ?? time
}

struct EventRow: View {
    @Environment(\.colorScheme) var scheme
    let event: WidgetEvent
    let now: Date
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2).fill(hexColor(event.color, fallback: appAccent(scheme))).frame(width: 4)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(timeAndPlace("\(event.start.formatted(timeFormat))–\(event.end.formatted(timeFormat))", event.place))
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

struct WidgetView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) var scheme
    let entry: Entry

    var body: some View {
        let limit = family == .systemSmall ? 2 : 4
        let shown = Array(entry.events.prefix(limit))
        VStack(alignment: .leading, spacing: 6) {
            Text(formatDate(entry.date))
                .font(.system(size: 11, weight: .bold)).foregroundStyle(appAccent(scheme))
            if shown.isEmpty {
                Text("予定はありません").font(.system(size: 13)).foregroundStyle(.secondary)
            } else {
                ForEach(shown) { EventRow(event: $0, now: entry.date) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct KichijitsuWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuWidget", provider: Provider()) { entry in
            WidgetView(entry: entry)
        }
        .configurationDisplayName("今日の予定")
        .description("これからの予定を表示します。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
