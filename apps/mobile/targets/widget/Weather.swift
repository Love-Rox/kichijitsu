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
    /// true なら、描くたびに最新の現在地を取る(取れないときは、上の座標を使う)
    let followsCurrent: Bool?
}

/// 現在地を一度だけ取る。位置情報の許可(使用中のみ)は、アプリが取っておく。ウィジェットは許可を求められない。
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    func fetch() async -> CLLocation? {
        let status = manager.authorizationStatus
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return nil }
        // 直近(15 分以内)の位置があれば、それを使う
        if let last = manager.location, Date().timeIntervalSince(last.timestamp) < 15 * 60 { return last }
        return await withCheckedContinuation { (c: CheckedContinuation<CLLocation?, Never>) in
            continuation = c
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyKilometer
            manager.requestLocation()
            // 取れないまま待ち続けないよう、8 秒で切り上げる
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.finish(self?.manager.location) }
        }
    }

    private func finish(_ location: CLLocation?) {
        continuation?.resume(returning: location)
        continuation = nil
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.finish(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(self.manager.location) }
    }
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
    /// 取得に失敗した。理由(エラーの種類)の短い文字列を持つ(ウィジェットに出して、原因を切り分けられるように)
    case unavailable(String)
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
              abs(snap.latitude - place.latitude) < 0.02, abs(snap.longitude - place.longitude) < 0.02
        else { return nil }
        return snap
    }

    private static func saveCache(_ snap: WeatherSnapshot) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(snap), let raw = String(data: data, encoding: .utf8) else { return }
        UserDefaults(suiteName: appGroup)?.set(raw, forKey: cacheKey)
    }

    /// 現在地に追従する設定なら、最新の現在地(と、その名前)に置き換える。取れなければ、保存した場所のまま。
    private static func resolve(_ saved: WeatherPlace) async -> WeatherPlace {
        guard saved.followsCurrent == true, let location = await OneShotLocation().fetch() else { return saved }
        var name = saved.name
        if let mark = try? await CLGeocoder().reverseGeocodeLocation(location, preferredLocale: Locale(identifier: "ja_JP")).first {
            let parts = [mark.administrativeArea, mark.locality ?? mark.subAdministrativeArea, mark.subLocality]
                .compactMap { $0 }
            let uniq = parts.enumerated().filter { parts.firstIndex(of: $0.element) == $0.offset }.map(\.element)
            if !uniq.isEmpty { name = uniq.joined(separator: " ") }
        }
        return WeatherPlace(name: name, latitude: location.coordinate.latitude,
                            longitude: location.coordinate.longitude, followsCurrent: true)
    }

    /// エラーを、画面に出せる短い文字列にする(WeatherKit の認証エラーは、権限・有効化の待ちが原因のことが多い)
    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        return "\(ns.domain.split(separator: ".").last ?? "")#\(ns.code)"
    }

    static func load() async -> (place: WeatherPlace?, state: WeatherState) {
        guard let savedPlace = loadPlace() else { return (nil, .noPlace) }
        let place = await resolve(savedPlace)
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
            return (place, .unavailable(describe(error)))
        }
    }
}
