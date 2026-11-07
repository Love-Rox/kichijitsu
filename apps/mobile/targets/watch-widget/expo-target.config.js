/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "watch-widget",
  name: "kichijitsu-watch-widget",
  displayName: "kichijitsu",
  // Watch アプリ(…kichijitsu.watch)の中に入る拡張は、その bundle id の下(…watch.widget)でなければならない
  bundleIdentifier: ".watch.widget",
  deploymentTarget: "10.0",
  // Watch アプリが書いた予定の一覧を、コンプリケーションが読む(Watch 側の App Group)
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
