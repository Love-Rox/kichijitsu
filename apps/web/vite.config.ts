import { execSync } from "node:child_process";
import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";

/**
 * ビルド番号表示 (ユーザー要望、2026-07-22)。リモート URL 方式のデスクトップアプリでは
 * webview がキャッシュ済みの古いビルドを表示し続けることがあり、「いま見ているビルドが
 * どれか」を確認する手段が無かった。ここでビルド時の git SHA とビルド時刻を静的に
 * 埋め込み、src/version.ts 経由で設定モーダルに表示する(SettingsModal.tsx 参照)。
 *
 * git 情報が取れない環境(shallow clone や .git 無しの配布物ビルド等)でも
 * ビルド自体は落とさない ―― 失敗時は "dev" にフォールバックする。
 */
function resolveBuildSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

const BUILD_SHA = resolveBuildSha();
const BUILD_TIME = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  lint: {
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
        },
      ],
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  plugins: lazyPlugins(() => [react()]),
  server: {
    proxy: {
      // apps/sync (wrangler dev, localhost:8787) への開発プロキシ。
      // バックエンドが起動していない場合は 502 系のレスポンスになるが、
      // アプリ側 (App.tsx) はそれを「未接続」として静かに扱う。
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/auth": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
