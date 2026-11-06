// モノレポ内の共有コード (packages/shared など) を Metro に見せる。
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [path.join(repoRoot, "packages/shared")];
config.resolver.extraNodeModules = {
  "@kichijitsu/shared": path.join(repoRoot, "packages/shared/src"),
};
module.exports = config;
