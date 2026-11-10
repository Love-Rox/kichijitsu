/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "kichijitsu-widget",
  displayName: "kichijitsu",
  deploymentTarget: "17.0",
  // アプリと同じ App Group(アプリが書いた予定の一覧・天気の場所を、ウィジェットが読む)。
  // WeatherKit: 天気の予報をウィジェット自身が取る(App ID の WeatherKit 権限が要る)
  entitlements: {
    "com.apple.developer.weatherkit": true,
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
