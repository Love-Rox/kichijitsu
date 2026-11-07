import Foundation
import SwiftUI
import WatchConnectivity
import WidgetKit

// iPhone → Watch の受け口。applicationContext は「最新の 1 通」だけが届く(古いものは上書き)ので、
// 一覧の送り直しに向いている。届いたキー("events" / "theme")を、そのまま App Group の UserDefaults に
// 書く。形式は iPhone 側のウィジェットと同じ:
//   events: { "updatedAt": <ms>, "events": [{ "title", "startMs", "endMs", "color" }] }(JSON 文字列)
//   theme:  { "light": "#rrggbb", "dark": "#rrggbb" }(JSON 文字列)
// iPhone でログアウトすると、空の events が届いて、一覧が消える。
let appGroup = "group.cc.love-rox.kichijitsu"

struct WatchEvent: Decodable, Identifiable {
    let title: String
    let startMs: Double
    let endMs: Double
    let color: String?
    var id: String { "\(startMs)-\(title)" }
    var start: Date { Date(timeIntervalSince1970: startMs / 1000) }
    var end: Date { Date(timeIntervalSince1970: endMs / 1000) }
}

private struct EventsPayload: Decodable {
    let updatedAt: Double?
    let events: [WatchEvent]
}

private struct ThemePayload: Decodable { let light: String; let dark: String }

func parseHex(_ hex: String?) -> Color? {
    guard let s = hex?.trimmingCharacters(in: CharacterSet(charactersIn: "#")), s.count == 6,
          let v = UInt32(s, radix: 16) else { return nil }
    return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

/// 既定の朱(ダーク)。Watch は常に暗いので、ダーク用の色を使う。
let defaultAccent = Color(red: 0xEA / 255, green: 0x64 / 255, blue: 0x51 / 255)

final class WatchStore: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var events: [WatchEvent] = []
    @Published private(set) var updatedAt: Date?
    @Published private(set) var accent: Color = defaultAccent

    private let defaults = UserDefaults(suiteName: appGroup)

    override init() {
        super.init()
        reload()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func reload() {
        if let raw = defaults?.string(forKey: "events"),
           let data = raw.data(using: .utf8),
           let payload = try? JSONDecoder().decode(EventsPayload.self, from: data) {
            events = payload.events.sorted { $0.start < $1.start }
            updatedAt = payload.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
        } else {
            events = []
            updatedAt = nil
        }
        if let raw = defaults?.string(forKey: "theme"),
           let data = raw.data(using: .utf8),
           let theme = try? JSONDecoder().decode(ThemePayload.self, from: data),
           let c = parseHex(theme.dark) {
            accent = c
        }
    }

    private func apply(_ context: [String: Any]) {
        for key in ["events", "theme"] {
            if let value = context[key] as? String { defaults?.set(value, forKey: key) }
        }
        DispatchQueue.main.async {
            self.reload()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // 起動前に届いていた最新の内容を拾う(iPhone が先に送っていた場合)
        if activationState == .activated, !session.receivedApplicationContext.isEmpty {
            apply(session.receivedApplicationContext)
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }
}
