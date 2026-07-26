import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * 公式インスタンスの紹介サイト (2026-07-26 に apps/web から分離)。
 *
 * **なぜ apps/web から切り出したか**: apps/web/wrangler.jsonc は `apps/web/dist` を
 * まるごと assets Worker に上げる。紹介サイト (ランディング `/`、MCP ガイド `/mcp/`、
 * セルフホスト手順 `/self-hosting/`) が dist に同居していると、セルフホストした人の
 * ドメインで「公式インスタンス (kichijitsu.love-rox.cc) の宣伝ページ」が配信されてしまう。
 * 規約ページの運営者情報 (apps/web/build/legalText.ts) と同じ種類の事故なので、
 * こちらは成果物ごと切り離した。
 *
 * **配信のされ方**: 別 Worker には分けていない。`pnpm build:official` (公式ビルド専用) が
 * web → site の順にビルドし、site の dist を web の dist へコピーして合流させる
 * (ルート package.json 参照)。したがって公開 URL は分離前と完全に同じで、
 * `/` `/mcp/` `/self-hosting/` はこれまでどおり単一の kichijitsu-web Worker から出る。
 * セルフホストが叩く `pnpm build` は web だけをビルドするので、これらは dist に入らない。
 *
 * 3ページとも JS を持たず、CSS もインライン <style> で自己完結しているので、
 * ここでの設定はマルチページ入力と出力先の調整だけでよい。
 */

// マルチページビルド用の入力解決 (プロジェクトルート基準の絶対パスを要求する
// rollupOptions.input 向け。apps/web/vite.config.ts と同じ書き方)。
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  /**
   * apps/site/public/ の中身 (favicon.svg / wordmark.svg / icons/apple-touch-icon.png) は
   * **apps/web/public/ と同じファイルの複製**。既定値と同じ "public" をあえて明示して、
   * この注意書きを置いている。
   *
   * なぜ複製するのか: これらはサイト3ページとアプリ側 (app/index.html の favicon・
   * apple-touch-icon、privacy.html / terms.html のワードマーク) の**両方**が参照するため、
   * apps/web から移動させることができない。かといってサイト側に無いと `pnpm build:site`
   * 単体の成果物が画像切れになる (合流前提のパスなので相対化でも解決しない)。
   * symlink やビルド時コピーで一元化する手もあるが、たかだか3ファイルの静的アセットのために
   * ビルドの仕組みを増やす方が読み手のコストが高いと判断して、素直に複製している。
   *
   * ブランド資産の正は常にリポジトリルートの brand/ 配下 (brand/README.md 参照)。
   * 差し替えるときは apps/web/public/ と apps/site/public/ の両方を更新すること。
   */
  publicDir: "public",
  build: {
    /**
     * 既定の "assets" ではなく "site-assets" にしている。
     *
     * 合流 (site の dist を web の dist へ上書きコピー) するとき、両者が同じ
     * `assets/` を使っていると site 側のファイル群がアプリ本体の
     * `dist/assets/` に混ざる。ハッシュ付きファイル名なので実害が出るのは
     * 稀だが、「アプリのバンドルが入っているディレクトリ」を紹介サイトの
     * ビルドが触れる状態そのものが事故のもとなので、名前空間を分けておく。
     */
    assetsDir: "site-assets",
    rollupOptions: {
      input: {
        landing: r("./index.html"),
        mcp: r("./mcp/index.html"),
        selfHosting: r("./self-hosting/index.html"),
      },
    },
  },
});
