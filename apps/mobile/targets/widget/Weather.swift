import CoreLocation
import Foundation
import WeatherKit

// 天気(Apple WeatherKit)。場所はアプリの設定で選び、App Group の "weatherPlace" に
// { "name", "latitude", "longitude" } の JSON で入る(空文字は未設定)。
// 取った予報は同じ App Group の "weatherCache" に JSON で残す(通信に失敗したとき、古くても出せるように)。
// WeatherKit の呼び出しには、このターゲットの entitlement(com.apple.developer.weatherkit)が要る。

struct WeatherPlace: Decodable {
    let name: String
    let latitude: Double
    let longitude: Double
}

struct WeatherHour: Codable, Identifiable {
    let date: Date
    let temp: Double          // 摂氏
    let symbol: String        // SF Symbols の名前
    let precip: Double        // 降水確率 0...1
    var id: Date { date }
}

struct WeatherDay: Codable, Identifiable {
    let date: Date
    let high: Double
    let low: Double
    let symbol: String
    let precip: Double
    var id: Date { date }
}

struct WeatherSnapshot: Codable {
    let latitude: Double
    let longitude: Double
    let fetchedAt: Date
    let hours: [WeatherHour]
    let days: [WeatherDay]
}

enum WeatherState {
    case noPlace
    case unavailable
    case ready(WeatherSnapshot)
}

enum WeatherLoader {
    private static let placeKey = "weatherPlace"
    private static let cacheKey = "weatherCache"
    /// この時間より新しい予報なら、取り直さない
    private static let freshness: TimeInterval = 25 * 60

    static func loadPlace() -> WeatherPlace? {
        guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: placeKey), !raw.isEmpty,
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(WeatherPlace.self, from: data)
    }

    private static func loadCache(for place: WeatherPlace) -> WeatherSnapshot? {
        guard let raw = UserDefaults(suiteName: appGroup)?.string(forKey: cacheKey),
              let data = raw.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        guard let snap = try? decoder.decode(WeatherSnapshot.self, from: data),
              abs(snap.latitude - place.latitude) < 0.0001, abs(snap.longitude - place.longitude) < 0.0001
        else { return nil }
        return snap
    }

    private static func saveCache(_ snap: WeatherSnapshot) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(snap), let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults(suiteName: appGroup)?.set(raw, forKey: cacheKey)
    }

    static func load() async -> (place: WeatherPlace?, state: WeatherState) {
        guard let place = loadPlace() else { return (nil, .noPlace) }
        let cached = loadCache(for: place)
        if let c = cached, Date().timeIntervalSince(c.fetchedAt) < freshness { return (place, .ready(c)) }
        do {
            let location = CLLocation(latitude: place.latitude, longitude: place.longitude)
            let (hourly, daily) = try await WeatherService.shared.weather(for: location, including: .hourly, .daily)
            let from = Date().addingTimeInterval(-3600)
            let hours = hourly.forecast.filter { $0.date >= from }.prefix(36).map {
                WeatherHour(
                    date: $0.date,
                    temp: $0.temperature.converted(to: .celsius).value,
                    symbol: $0.symbolName,
                    precip: $0.precipitationChance
                )
            }
            let days = daily.forecast.prefix(7).map {
                WeatherDay(
                    date: $0.date,
                    high: $0.highTemperature.converted(to: .celsius).value,
                    low: $0.lowTemperature.converted(to: .celsius).value,
                    symbol: $0.symbolName,
                    precip: $0.precipitationChance
                )
            }
            let snap = WeatherSnapshot(
                latitude: place.latitude, longitude: place.longitude, fetchedAt: Date(),
                hours: Array(hours), days: Array(days)
            )
            saveCache(snap)
            return (place, .ready(snap))
        } catch {
            // 通信や WeatherKit の失敗: 古い予報があればそれを出す
            if let c = cached { return (place, .ready(c)) }
            return (place, .unavailable)
        }
    }
}
