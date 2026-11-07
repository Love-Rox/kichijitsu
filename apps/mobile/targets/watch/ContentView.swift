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
        // 1 分ごとに、終わった予定を外して「いま」の表示を更新する
        TimelineView(.everyMinute) { context in
            let now = context.date
            let upcoming = store.events.filter { $0.end > now }
            let days = Set(upcoming.map { dayOf($0, now: now) }).sorted()
            NavigationStack {
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
                                ForEach(upcoming.filter { dayOf($0, now: now) == day }) {
                                    EventRow(event: $0, now: now)
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
