import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import { OPERATOR_ENV_KEYS, readOperatorInfo, renderLegalHtml } from "./build/legalText.ts";

// マルチページビルド用の入力解決 (プロジェクトルート基準の絶対パスを要求する
// rollupOptions.input 向け)。
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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

/**
 * 規約 / プライバシーポリシーの運営者情報をビルド時に差し込むプラグイン (2026-07-26)。
 *
 * dist はまるごと assets Worker に上がるので、`/privacy.html` `/terms.html` は
 * セルフホストした人のドメインでもそのまま配信される。公式インスタンスの運営者名・連絡先が
 * 焼き込まれていると「他人の規約が自分のインスタンスの規約として出る」「love-rox が
 * 運営していないインスタンスの運営者として名指しされる」という事故になるため、
 * これらは環境変数から差し込む (未設定なら中立の文言。文言と置換ロジックの本体は
 * apps/web/build/legalText.ts、テストは同ディレクトリの legalText.test.ts)。
 *
 * Vite 組み込みの `%VITE_FOO%` 置換を使わないのは、未設定時に空文字が入って
 * 「本インスタンス（）は が運営しています」のような壊れた日本語になるため。
 * また `VITE_` prefix を付けていないので、これらの値がクライアントバンドルに載ることもない。
 *
 * 値は process.env からのみ読む (.env ファイルは見ない)。公式ビルドでの渡し方は
 * ルート package.json の `build:official` / docs/deploy.md を参照。
 */
function legalOperatorPlugin() {
  const info = readOperatorInfo(process.env);
  const missing = Object.values(OPERATOR_ENV_KEYS).filter((key) => !process.env[key]?.trim());
  return {
    name: "kichijitsu:legal-operator",
    // 未設定でも「公式の情報が漏れる」ことは無い (中立の文言になる) のでビルドは落とさないが、
    // 公式デプロイでの設定漏れに気づけるよう本番ビルド時だけ警告を出す。dev / test では
    // 未設定が通常なので黙らせる。
    configResolved(config: { command: string }) {
      if (config.command === "build" && missing.length > 0) {
        console.warn(
          `[legal] 運営者情報が未設定です (${missing.join(", ")})。` +
            "/privacy.html /terms.html の該当箇所は「設定されていません」と表示されます。",
        );
      }
    },
    transformIndexHtml(html: string) {
      return renderLegalHtml(html, info);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  // マルチページ化 (2026-07-22): アプリ本体は /app へ移設し、トップ (/) や読み物ページを
  // 静的 HTML として並べている。base はデフォルト "/" のままなので共有 assets は
  // /assets/ 配下に出力される。Cloudflare 側の配信は wrangler.jsonc の assets
  // (html_handling: auto-trailing-slash) が /app → /app/ → dist/app/index.html を解決する。
  //
  // 紹介サイトの分離 (2026-07-26): 公式インスタンスの紹介ページ (ランディング / MCP ガイド
  // /mcp/ / セルフホスト手順 /self-hosting/) は apps/site へ切り出した。dist はまるごと
  // assets Worker に上がるため、同居させているとセルフホストした人のドメインで公式の
  // 宣伝ページが配信されてしまうため (規約ページの運営者情報と同じ種類の事故)。
  // 公式ビルドでは `pnpm build:official` が site の成果物をこの dist へ合流させるので、
  // 公開 URL と見た目は分離前から変わらない (ルート package.json 参照)。
  // → このパッケージが持つのは **アプリ本体 + 規約** だけ。
  build: {
    rollupOptions: {
      input: {
        // `/` の最小ページ。公式ビルドでは apps/site のランディングに上書きされる
        // (詳細は index.html 冒頭のコメント)。wrangler.jsonc の
        // not_found_handling: "single-page-application" が dist/index.html を要求するので、
        // セルフホストのビルドでもこれが必ず1つある状態を保つ。
        landing: r("./index.html"),
        app: r("./app/index.html"),
        // 規約 / プライバシーポリシー (2026-07-26 に public/ から移設)。public/ 配下は Vite が
        // 素通しコピーするだけで transformIndexHtml が効かず、運営者情報をビルド時に
        // 差し込めなかったため。ルート直下の input なので出力は dist/privacy.html /
        // dist/terms.html になり、公開 URL (/privacy.html /terms.html) は従来どおり変わらない。
        privacy: r("./privacy.html"),
        terms: r("./terms.html"),
      },
    },
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
  // PluginOption はネストした配列を許すので、lazyPlugins の戻り値をそのまま要素にできる。
  plugins: [legalOperatorPlugin(), lazyPlugins(() => [react()])],
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
