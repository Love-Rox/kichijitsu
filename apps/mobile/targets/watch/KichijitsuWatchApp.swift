import SwiftUI

// Apple Watch アプリ。予定は iPhone のアプリが WatchConnectivity(applicationContext)で送ってくる。
// 受け取った内容は WatchStore が Watch 側の App Group に保存し、コンプリケーションも同じものを読む。
@main
struct KichijitsuWatchApp: App {
    @StateObject private var store = WatchStore()

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store)
        }
    }
}
