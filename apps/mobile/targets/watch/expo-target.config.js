/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "watch",
  name: "kichijitsu-watch",
  displayName: "kichijitsu",
  icon: "../../assets/icon.png",
  deploymentTarget: "10.0",
  // 予定は iPhone から WatchConnectivity で届く。受け取った予定を、コンプリケーション(watch-widget)と
  // 共有するために、Watch 側の App Group に置く(iPhone 側の App Group とは別の領域)。
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
