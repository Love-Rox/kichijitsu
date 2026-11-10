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
            // 切り替えの時刻: 今、毎時 0 分と 10 分(時計の表示の切り替え。ClockText 参照)を 3 時間分、
            // 日付の変わり目、予定の開始・終了
            var times = Set<Date>([now])
            if let hour = cal.dateInterval(of: .hour, for: now)?.start {
                for k in 0..<4 {
                    for m in stride(from: 0, to: 60, by: 10) {
                        let t = hour.addingTimeInterval(Double(k) * 3600 + Double(m) * 60)
                        if t > now { times.insert(t) }
                    }
                }
            }
            if let midnight = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) { times.insert(midnight) }
            for e in all where e.end > now { times.insert(max(e.start, now)); times.insert(e.end) }
            let sorted = times.filter { $0 >= now }.sorted().prefix(40)
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
/// 「その時間の頭」からの経過時間は、1 時間未満なら「MM:SS」(分が 10 未満のときは「M:SS」)で出るので、
/// 「時」と、10 未満のときの先頭の「0」は、静的な文字で足す。そのため、時計の表示は 10 分ごとの
/// エントリで切り替える(切り抜きなどは使わない。ウィジェットの自動更新の文字は、加工すると消えることがある)。
struct ClockText: View {
    let date: Date
    let size: CGFloat

    var body: some View {
        let cal = Calendar.current
        let hourStart = cal.dateInterval(of: .hour, for: date)?.start ?? date
        let early = cal.component(.minute, from: date) < 10
        let font = Font.system(size: size, weight: .semibold, design: .rounded).monospacedDigit()
        HStack(spacing: 0) {
            Text(String(format: "%02d:", cal.component(.hour, from: date)) + (early ? "0" : "")).font(font)
            // 幅の基準(見えない)に、経過時間を左寄せで重ねる
            Text(early ? "0:00" : "00:00").font(font).hidden()
                .overlay(alignment: .leading) {
                    Text(hourStart, style: .timer).font(font).multilineTextAlignment(.leading)
                }
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
            Text(formatDate(entry.date))
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
        case .unavailable(let reason):
            Text("天気を取得できませんでした\n(\(reason))").font(.system(size: 10)).foregroundStyle(.secondary)
        case .ready:
            EmptyView()
        }
    }
}

/// 今の気温と、今日の最高・最低
struct WeatherHeader: View {
    let entry: StandByEntry
    let snapshot: WeatherSnapshot
    /// 縦に余裕がないとき(予定と天気の小サイズ)は、気温の文字を小さくする
    var compact = false
    var body: some View {
        let now = snapshot.hours.first { $0.date >= entry.date.addingTimeInterval(-3600) } ?? snapshot.hours.first
        let today = snapshot.days.first { Calendar.current.isDate($0.date, inSameDayAs: entry.date) }
        HStack(spacing: 6) {
            if let now {
                WeatherIcon(symbol: now.symbol, size: 22)
                Text(degrees(now.temp)).font(.system(size: compact ? 21 : 26, weight: .semibold, design: .rounded))
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
    /// 降水確率の行を省く(縦に余裕がないとき)
    var compact = false
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
                    if !compact { Text(percent(h.precip) ?? " ").font(.system(size: 9)).foregroundStyle(.cyan) }
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

/// どこの天気かを、小さく出す。現在地に追従しているときは、位置のマークをつける。
struct PlaceLabel: View {
    let place: WeatherPlace?
    var body: some View {
        if let place {
            HStack(spacing: 3) {
                Image(systemName: place.followsCurrent == true ? "location.fill" : "mappin").font(.system(size: 8))
                Text(place.name).lineLimit(1)
            }
            .font(.system(size: 10)).foregroundStyle(.secondary)
        }
    }
}

let weatherAttribution = Text("Apple Weather").font(.system(size: 8)).foregroundStyle(.tertiary)

struct WeatherSmallView: View {
    let entry: StandByEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if case .ready(let snap) = entry.weather {
                PlaceLabel(place: entry.place)
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
                PlaceLabel(place: entry.place)
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
                    PlaceLabel(place: entry.place)
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

/// 時計を「時」と「分:秒」の 2 段に積んだ版。1 行では、小サイズの幅に 8 文字を収めるため文字が小さくなるので、
/// 日時だけのウィジェットでは、2 段にして文字を大きくする。仕組みは ClockText と同じ(.timer を加工しない)。
struct ClockStackedText: View {
    let date: Date
    let hourSize: CGFloat
    let minSecSize: CGFloat

    var body: some View {
        let cal = Calendar.current
        let hourStart = cal.dateInterval(of: .hour, for: date)?.start ?? date
        let early = cal.component(.minute, from: date) < 10
        let hourFont = Font.system(size: hourSize, weight: .bold, design: .rounded).monospacedDigit()
        let font = Font.system(size: minSecSize, weight: .bold, design: .rounded).monospacedDigit()
        VStack(alignment: .leading, spacing: -minSecSize * 0.12) {
            Text(String(format: "%02d", cal.component(.hour, from: date))).font(hourFont)
            HStack(spacing: 0) {
                if early { Text("0").font(font) }
                Text(early ? "0:00" : "00:00").font(font).hidden()
                    .overlay(alignment: .leading) {
                        Text(hourStart, style: .timer).font(font).multilineTextAlignment(.leading)
                    }
            }
        }
        .lineLimit(1)
    }
}

/// 日時だけ(予定なし): 日付・曜日と、秒までの時計を、枠いっぱいに大きく
struct DateTimeBlock: View {
    @Environment(\.colorScheme) var scheme
    let entry: StandByEntry
    var body: some View {
        GeometryReader { geo in
            // 「MM:SS」(数字 4 + コロン 1)が幅に収まる大きさ。「時」は高さに余りを使う
            let minSec = min(geo.size.width / 3.3, geo.size.height * 0.38)
            let hour = min(geo.size.height * 0.40, geo.size.width / 1.3)
            VStack(alignment: .leading, spacing: 2) {
                Text(formatDate(entry.date))
                    .font(.system(size: 17, weight: .bold)).foregroundStyle(appAccent(scheme))
                    .lineLimit(2).minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                ClockStackedText(date: entry.date, hourSize: hour, minSecSize: minSec)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

struct StandByDateTimeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByDateTime", provider: StandByProvider(needsWeather: false)) { entry in
            DateTimeBlock(entry: entry).containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("日時")
        .description("日付・曜日と、秒まで進む時計だけを表示します。")
        .supportedFamilies([.systemSmall])
    }
}

/// 次の予定と天気をまとめた小サイズ(時計なし)
struct AgendaWeatherView: View {
    let entry: StandByEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let next = entry.events.first {
                StandByEventRow(event: next, now: entry.date)
            } else {
                Text("この後の予定はありません").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            if case .ready(let snap) = entry.weather {
                PlaceLabel(place: entry.place)
                WeatherHeader(entry: entry, snapshot: snap, compact: true)
                HourlyStrip(entry: entry, snapshot: snap, step: 3, count: 4, compact: true)
                Spacer(minLength: 0)
            } else {
                Divider()
                WeatherNote(state: entry.weather)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct StandByAgendaWeatherWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KichijitsuStandByAgendaWeather", provider: StandByProvider(needsWeather: true)) { entry in
            AgendaWeatherView(entry: entry).containerBackground(for: .widget) { PaleBackground() }
        }
        .configurationDisplayName("予定と天気")
        .description("次の予定と、今の天気・これからの天気を 1 枚にまとめて表示します。")
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
        StandByDateTimeWidget()
        StandByClockWidget()
        StandByAgendaWeatherWidget()
        StandByWeatherWidget()
        StandByWeeklyWidget()
        StandByCombinedWidget()
    }
}
