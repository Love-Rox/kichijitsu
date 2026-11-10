import SwiftUI
import WidgetKit

// StandBy(充電中の横向き表示)向けのウィジェット。小サイズ(StandBy に置けるのはこの大きさ)で、
//   - 時計と予定(秒まで・日付・曜日・これからの予定)
//   - 天気(今日の時間帯別)
//   - 週間天気
// と、ホーム画面・iPad 向けに 3 つをまとめた中サイズ。
// StandBy のナイトモード(赤みのモノトーン)でも読めるよう、色だけに頼らず明暗とレイアウトで見せる。

struct StandByEntry: TimelineEntry {
    let date: Date
    let events: [WidgetEvent]       // date の時点で終わっていない予定(開始順)
    let place: WeatherPlace?
    let weather: WeatherState
}

struct StandByProvider: TimelineProvider {
    let needsWeather: Bool

    func placeholder(in context: Context) -> StandByEntry {
        StandByEntry(date: Date(), events: [], place: nil, weather: .noPlace)
    }

    func getSnapshot(in context: Context, completion: @escaping (StandByEntry) -> Void) {
        let now = Date()
        Task {
            let loaded = needsWeather ? await WeatherLoader.load() : (place: nil, state: WeatherState.noPlace)
            completion(StandByEntry(
                date: now, events: loadEvents().filter { $0.end > now },
                place: loaded.place, weather: loaded.state
            ))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StandByEntry>) -> Void) {
        let now = Date()
        Task {
            let loaded = needsWeather ? await WeatherLoader.load() : (place: nil, state: WeatherState.noPlace)
            let all = loadEvents()
            let cal = Calendar.current
            // 切り替えの時刻: 今、毎時(時計の「時」の桁)、日付の変わり目、予定の開始・終了、30 分ごと(天気の並び)
            var times = Set<Date>([now])
            if let hour = cal.dateInterval(of: .hour, for: now)?.end {
                for k in 0..<6 { times.insert(hour.addingTimeInterval(Double(k) * 3600)) }
            }
            if let midnight = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) { times.insert(midnight) }
            for e in all where e.end > now { times.insert(max(e.start, now)); times.insert(e.end) }
            for k in 1...4 { times.insert(now.addingTimeInterval(Double(k) * 1800)) }
            let sorted = times.filter { $0 >= now }.sorted().prefix(24)
            let entries = sorted.map { t in
                StandByEntry(date: t, events: all.filter { $0.end > t }, place: loaded.place, weather: loaded.state)
            }
            // 最後のエントリの後、または 1 時間後に読み直す(天気を取り直す)
            let reload = min(now.addingTimeInterval(3600), (sorted.last ?? now).addingTimeInterval(60))
            completion(Timeline(entries: entries, policy: .after(max(reload, now.addingTimeInterval(300)))))
        }
    }
}

// MARK: - 時計

/// 時分秒の時計。ウィジェットは秒ごとに描き直せないので、自動で進む `.timer` 表示を使う。
/// 「その時間の頭(1 時間前)」からの経過時間を出すと、常に「H:MM:SS」(H は 1 以上)の形になるので、
/// 末尾 5 桁(MM:SS)だけを切り出す。「時」は 1 時間ごとのエントリで入れ替える。
struct ClockText: View {
    let date: Date
    let size: CGFloat

    var body: some View {
        let cal = Calendar.current
        let hourStart = cal.dateInterval(of: .hour, for: date)?.start ?? date
        let font = Font.system(size: size, weight: .semibold, design: .rounded).monospacedDigit()
        HStack(spacing: 0) {
            Text(String(format: "%02d:", cal.component(.hour, from: date))).font(font)
            // 幅の基準(MM:SS)に、経過時間を右寄せで重ね、はみ出した左の「H:」を切る
            Text("00:00").font(font).hidden()
                .overlay(alignment: .trailing) {
                    Text(hourStart.addingTimeInterval(-3600), style: .timer)
                        .font(font)
                        .fixedSize()
                }
                .clipped()
        }
        .lineLimit(1)
    }
}

struct ClockBlock: View {
    @Environment(\.colorScheme) var scheme
    let entry: StandByEntry
    let clockSize: CGFloat
    let eventLimit: Int

    var body: some View {
        let shown = Array(entry.events.prefix(eventLimit))
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.date.formatted(.dateTime.month().day().weekday()))
                .font(.system(size: 13, weight: .bold)).foregroundStyle(appAccent(scheme))
            ClockText(date: entry.date, size: clockSize)
            if shown.isEmpty {
                Text("この後の予定はありません").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            } else {
                ForEach(shown) { StandByEventRow(event: $0, now: entry.date) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct StandByEventRow: View {
    @Environment(\.colorScheme) var scheme
    let event: WidgetEvent
    let now: Date
    var body: some View {
        let ongoing = event.start <= now
        HStack(alignment: .top, spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(hexColor(event.color, fallback: appAccent(scheme))).frame(width: 3)
            VStack(alignment: .leading, spacing: 0) {
                Text(event.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(ongoing ? "〜\(event.end.formatted(timeFormat))" : "\(event.start.formatted(timeFormat))–\(event.end.formatted(timeFormat))")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - 天気

/// 天気のアイコン(デュオトーン)。SF Symbols の 2 層を、落ち着いた色(雲など)とアクセント色(太陽・雨など)で塗る。
/// StandBy のナイトモードなど、OS が単色にする場面では、OS の色づけに従う。
struct WeatherIcon: View {
    @Environment(\.colorScheme) var scheme
    let symbol: String
    let size: CGFloat
    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.palette)
            .foregroundStyle(Color.primary.opacity(0.55), appAccent(scheme))
            .font(.system(size: size))
    }
}

private func degrees(_ v: Double) -> String { "\(Int(v.rounded()))°" }
private func percent(_ v: Double) -> String? { v >= 0.1 ? "\(Int((v * 10).rounded()) * 10)%" : nil }

/// 天気が出せないときの、短い案内
struct WeatherNote: View {
    let state: WeatherState
    var body: some View {
        switch state {
        case .noPlace:
            Text("アプリの設定で\n天気の場所を選んでください").font(.system(size: 11)).foregroundStyle(.secondary)
        case .unavailable:
            Text("天気を取得できませんでした").font(.system(size: 11)).foregroundStyle(.secondary)
        case .ready:
            EmptyView()
        }
    }
}

/// 今の気温と、今日の最高・最低
struct WeatherHeader: View {
    let entry: StandByEntry
    let snapshot: WeatherSnapshot
    var body: some View {
        let now = snapshot.hours.first { $0.date >= entry.date.addingTimeInterval(-3600) } ?? snapshot.hours.first
        let today = snapshot.days.first { Calendar.current.isDate($0.date, inSameDayAs: entry.date) }
        HStack(spacing: 6) {
            if let now {
                WeatherIcon(symbol: now.symbol, size: 22)
                Text(degrees(now.temp)).font(.system(size: 26, weight: .semibold, design: .rounded))
            }
            Spacer(minLength: 0)
            if let today {
                VStack(alignment: .trailing, spacing: 0) {
                    Text("最高 \(degrees(today.high))").font(.system(size: 11, weight: .semibold))
                    Text("最低 \(degrees(today.low))").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// 時間帯別。`step` 時間おきに `count` 個
struct HourlyStrip: View {
    let entry: StandByEntry
    let snapshot: WeatherSnapshot
    let step: Int
    let count: Int
    var body: some View {
        let from = entry.date.addingTimeInterval(-1800)
        let upcoming = snapshot.hours.filter { $0.date >= from }
        let picked = stride(from: 0, to: upcoming.count, by: step).prefix(count).map { upcoming[$0] }
        HStack(alignment: .top, spacing: 0) {
            ForEach(picked) { h in
                VStack(spacing: 2) {
                    Text("\(Calendar.current.component(.hour, from: h.date))時").font(.system(size: 10)).foregroundStyle(.secondary)
                    WeatherIcon(symbol: h.symbol, size: 15).frame(height: 18)
                    Text(degrees(h.temp)).font(.system(size: 12, weight: .semibold))
                    Text(percent(h.precip) ?? " ").font(.system(size: 9)).foregroundStyle(.cyan)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// 日ごと。`count` 日分
struct DailyList: View {
    let snapshot: WeatherSnapshot
    let entry: StandByEntry
    let count: Int
    var body: some View {
        let today = Calendar.current.startOfDay(for: entry.date)
        let days = snapshot.days.filter { $0.date >= today }.prefix(count)
        VStack(spacing: 3) {
            ForEach(Array(days)) { d in
                HStack(spacing: 6) {
                    Text(Calendar.current.isDate(d.date, inSameDayAs: entry.date) ? "今日" : d.date.formatted(.dateTime.weekday(.abbreviated)))
                        .font(.system(size: 12, weight: .semibold)).frame(width: 30, alignment: .leading)
                    WeatherIcon(symbol: d.symbol, size: 14).frame(width: 22)
                    Text(percent(d.precip) ?? "").font(.system(size: 10)).foregroundStyle(.cyan).frame(width: 30, alignment: .leading)
                    Spacer(minLength: 0)
                    Text(degrees(d.low)).font(.system(size: 12)).foregroundStyle(.secondary)
                    Text(degrees(d.high)).font(.system(size: 12, weight: .semibold))
                }
            }
        }
    }
}

let weatherAttribution = Text("Apple Weather").font(.system(size: 8)).foregroundStyle(.tertiary)

struct WeatherSmallView: View {
    let entry: StandByEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .ready(let snap) = entry.weather {
                if let name = entry.place?.name {
                    Text(name).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                WeatherHeader(entry: entry, snapshot: snap)
                HourlyStrip(entry: entry, snapshot: snap, step: 3, count: 4)
                Spacer(minLength: 0)
                weatherAttribution
            } else {
                WeatherNote(state: entry.weather)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct WeeklyWeatherView: View {
    let entry: StandByEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if case .ready(let snap) = entry.weather {
                if let name = entry.place?.name {
                    Text(name).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                DailyList(snapshot: snap, entry: entry, count: 5)
                Spacer(minLength: 0)
                weatherAttribution
            } else {
                WeatherNote(state: entry.weather)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// 時計・予定・天気をまとめた中サイズ(ホーム画面・iPad 向け)
struct StandByCombinedView: View {
    let entry: StandByEntry
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ClockBlock(entry: entry, clockSize: 28, eventLimit: 2)
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                if case .ready(let snap) = entry.weather {
                    WeatherHeader(entry: entry, snapshot: snap)
                    HourlyStrip(entry: entry, snapshot: snap, step: 3, count: 4)
                    Spacer(minLength: 0)
                    weatherAttribution
                } else {
                    WeatherNote(state: entry.weather)
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - ウィジェット

/// 通常時の背景: アプリのアクセント色を、ごく淡く敷く(StandBy では OS が背景を外し、ナイトモードでは赤みの単色にする)
struct PaleBackground: View {
    @Environment(\.colorScheme) var scheme
    var body: some View {
        ZStack {
            Rectangle().fill(.background)
            Rectangle().fill(appAccent(scheme).opacity(scheme == .dark ? 0.16 : 0.09))
        }
    }
}

struct StandByClockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByClock", provider: StandByProvider(needsWeather: false)) { entry in
            ClockBlock(entry: entry, clockSize: 27, eventLimit: 2)
                .containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("時計と予定")
        .description("秒まで進む時計と、日付・曜日、これからの予定を表示します。StandBy にも置けます。")
        .supportedFamilies([.systemSmall])
    }
}

struct StandByWeatherWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByWeather", provider: StandByProvider(needsWeather: true)) { entry in
            WeatherSmallView(entry: entry).containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("天気(時間帯別)")
        .description("今の気温と、これから 12 時間の天気を表示します。場所はアプリの設定で選びます。")
        .supportedFamilies([.systemSmall])
    }
}

struct StandByWeeklyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByWeekly", provider: StandByProvider(needsWeather: true)) { entry in
            WeeklyWeatherView(entry: entry).containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("週間天気")
        .description("今日から 5 日分の天気と気温を表示します。場所はアプリの設定で選びます。")
        .supportedFamilies([.systemSmall])
    }
}

struct StandByCombinedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByCombined", provider: StandByProvider(needsWeather: true)) { entry in
            StandByCombinedView(entry: entry).containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("時計・予定・天気")
        .description("時計と予定、天気を 1 枚にまとめて表示します。")
        .supportedFamilies([.systemMedium])
    }
}

@main
struct KichijitsuWidgetBundle: WidgetBundle {
    var body: some Widget {
        KichijitsuWidget()
        StandByClockWidget()
        StandByWeatherWidget()
        StandByWeeklyWidget()
        StandByCombinedWidget()
    }
}
