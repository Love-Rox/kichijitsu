import SwiftUI

private let timeFormat: Date.FormatStyle = .dateTime.hour().minute()

private func dayTitle(_ day: Date, now: Date) -> String {
    let cal = Calendar.current
    if cal.isDate(day, inSameDayAs: now) { return "今日" }
    if let tomorrow = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(day, inSameDayAs: tomorrow) { return "明日" }
    return day.formatted(.dateTime.month().day().weekday())
}

/// 予定を載せる日。日またぎで、すでに始まっている予定は「今日」に入れる(昨日の見出しを作らない)。
private func dayOf(_ e: WatchEvent, now: Date) -> Date {
    max(Calendar.current.startOfDay(for: e.start), Calendar.current.startOfDay(for: now))
}

struct EventRow: View {
    @EnvironmentObject var store: WatchStore
    let event: WatchEvent
    let now: Date

    private var ongoing: Bool { event.start <= now && event.end > now }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(parseHex(event.color) ?? store.accent)
                .frame(width: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title).font(.system(size: 15, weight: .semibold)).lineLimit(2)
                HStack(spacing: 4) {
                    Text("\(event.start.formatted(timeFormat))–\(event.end.formatted(timeFormat))")
                        .foregroundStyle(.secondary)
                    if ongoing { Text("いま").foregroundStyle(store.accent).fontWeight(.bold) }
                }
                .font(.system(size: 12))
            }
        }
        .padding(.vertical, 2)
    }
}

struct ContentView: View {
    @EnvironmentObject var store: WatchStore

    var body: some View {
        // NavigationStack を外側に置く(1 分ごとの更新で、開いた詳細が戻らないように)
        NavigationStack {
            // 1 分ごとに、終わった予定を外して「いま」の表示を更新する
            TimelineView(.everyMinute) { context in
                let now = context.date
                let upcoming = store.events.filter { $0.end > now }
                let days = Set(upcoming.map { dayOf($0, now: now) }).sorted()
                if upcoming.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "calendar").font(.title2).foregroundStyle(store.accent)
                        Text("予定はありません").font(.system(size: 14)).foregroundStyle(.secondary)
                        if store.updatedAt == nil {
                            Text("iPhone のアプリを開くと、予定が届きます").font(.system(size: 11))
                                .foregroundStyle(.tertiary).multilineTextAlignment(.center)
                        }
                    }
                } else {
                    List {
                        ForEach(days, id: \.self) { day in
                            Section {
                                ForEach(upcoming.filter { dayOf($0, now: now) == day }) { event in
                                    NavigationLink {
                                        EventDetailView(event: event)
                                    } label: {
                                        EventRow(event: event, now: now)
                                    }
                                }
                            } header: {
                                Text(dayTitle(day, now: now)).foregroundStyle(store.accent).fontWeight(.bold)
                            }
                        }
                    }
                    .navigationTitle("予定")
                }
            }
        }
    }
}

/// 残りの時間を「30分」「2時間5分」「3日」のように短く言う
private func spanText(_ seconds: TimeInterval) -> String {
    let minutes = max(1, Int((seconds / 60).rounded(.up)))
    if minutes < 60 { return "\(minutes)分" }
    if minutes < 24 * 60 {
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "\(h)時間" : "\(h)時間\(m)分"
    }
    return "\(minutes / (24 * 60))日"
}

/// 予定の詳細。一覧の行をタップして開く。
struct EventDetailView: View {
    @EnvironmentObject var store: WatchStore
    let event: WatchEvent

    private var dateText: String {
        let cal = Calendar.current
        if cal.isDate(event.start, inSameDayAs: event.end) {
            return "\(event.start.formatted(.dateTime.month().day().weekday())) \(event.start.formatted(timeFormat))–\(event.end.formatted(timeFormat))"
        }
        let full: Date.FormatStyle = .dateTime.month().day().hour().minute()
        return "\(event.start.formatted(full)) –\n\(event.end.formatted(full))"
    }

    var body: some View {
        TimelineView(.everyMinute) { context in
            let now = context.date
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    // 一番上に、カレンダーの色の丸と、カレンダー名
                    if let cal = event.calendar, !cal.isEmpty {
                        let calColor = parseHex(event.calendarColor) ?? parseHex(event.color) ?? store.accent
                        HStack(spacing: 5) {
                            Circle().fill(calColor).frame(width: 8, height: 8)
                            Text(cal).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        }
                        .foregroundStyle(calColor)
                    }

                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(parseHex(event.color) ?? store.accent)
                            .frame(width: 4)
                        Text(event.title).font(.system(size: 17, weight: .bold))
                    }
                    .fixedSize(horizontal: false, vertical: true)

                    Label(dateText, systemImage: "clock").font(.system(size: 14))

                    if event.start <= now && event.end > now {
                        Text("いま・あと\(spanText(event.end.timeIntervalSince(now)))")
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(store.accent)
                    } else if event.start > now {
                        Text("\(spanText(event.start.timeIntervalSince(now)))後に開始")
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                    }

                    if let loc = event.location, !loc.isEmpty {
                        Label(loc, systemImage: "mappin.and.ellipse").font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("詳細")
        }
    }
}
