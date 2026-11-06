// モノレポ内の共有コードを Metro に見せる。
//  - packages/shared: 型 (@kichijitsu/shared)
//  - apps/web/src: Web の純粋なロジック (予定の変換・繰り返し展開・重なり配置など)。
//    `@kichijitsu/web/...` で参照する。DOM や IndexedDB に依存するファイルは import しないこと
//    (純粋かどうかの機械的な確認は docs/mobile.md を参照)。
//    将来、安定したら packages/core へ移す。
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(repoRoot, "packages/shared"), path.join(repoRoot, "apps/web/src")];
config.resolver.extraNodeModules = {
  "@kichijitsu/shared": path.join(repoRoot, "packages/shared/src"),
  "@kichijitsu/web": path.join(repoRoot, "apps/web/src"),
};
// Web 側のファイル (apps/web/src) が import する @js-temporal/polyfill は、Web 側の node_modules
// ではなくこのアプリの node_modules から解決する。そうしないと、同じライブラリが2つバンドルされ、
// 別々の Temporal クラスが混ざって比較が壊れる。
const webSrc = path.join(repoRoot, "apps/web/src");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@js-temporal/polyfill" && context.originModulePath.startsWith(webSrc)) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, "index.js") },
      moduleName,
      platform,
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
