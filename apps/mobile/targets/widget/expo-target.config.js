/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "kichijitsu-widget",
  displayName: "kichijitsu",
  deploymentTarget: "17.0",
  // アプリと同じ App Group(アプリが書いた予定の一覧を、ウィジェットが読む)
  entitlements: {
    "com.apple.security.application-groups": config.ios.entitlements["com.apple.security.application-groups"],
  },
});
