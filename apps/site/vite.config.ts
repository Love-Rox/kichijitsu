import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

/**
 * 公式インスタンスの紹介サイト (2026-07-26 に apps/web から分離)。
 *
 * **なぜ apps/web から切り出したか**: apps/web/wrangler.jsonc は `apps/web/dist` を
 * まるごと assets Worker に上げる。紹介サイト (ランディング `/`、MCP ガイド `/mcp/`、
 * セルフホスト手順 `/self-hosting/`、ドキュメント `/docs/**`) が dist に同居していると、セルフホストした人の
 * ドメインで「公式インスタンス (kichijitsu.love-rox.cc) の宣伝ページ」が配信されてしまう。
 * 規約ページの運営者情報 (apps/web/build/legalText.ts) と同じ種類の事故なので、
 * こちらは成果物ごと切り離した。
 *
 * **配信のされ方**: 別 Worker には分けていない。`pnpm build:official` (公式ビルド専用) が
 * web → site の順にビルドし、site の dist を web の dist へコピーして合流させる
 * (ルート package.json 参照)。したがって公開 URL は分離前と完全に同じで、
 * `/` `/mcp/` `/self-hosting/` `/docs/**` はこれまでどおり単一の kichijitsu-web Worker から出る。
 * セルフホストが叩く `pnpm build` は web だけをビルドするので、これらは dist に入らない。
 *
 * どのページも JS を持たない。CSS はランディングだけがインライン <style> で自己完結し、
 * ドキュメント系 (`/mcp/` `/self-hosting/` `/docs/**`) は apps/site/doc-shell.css を
 * <link> で共有する (10ページぶんの全文コピーを避けるため。経緯は doc-shell.css 冒頭)。
 * したがってここでの設定はマルチページ入力と出力先の調整だけでよい。
 */

// マルチページビルド用の入力解決 (プロジェクトルート基準の絶対パスを要求する
// rollupOptions.input 向け。apps/web/vite.config.ts と同じ書き方)。
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * 公式インスタンスの公開オリジン。**ここに書いてよいのは apps/site だけ**。
 *
 * apps/web の成果物はセルフホストした人のドメインでそのまま配信されるので、
 * 向こうに公式ホスト名を焼き込むと「他人のインスタンスが公式を名乗る」事故になる
 * (このファイル冒頭のコメントと dbac3ad 参照)。site は公式専用パッケージなので、
 * OGP に必須の絶対 URL をここで持てる。
 */
const SITE_ORIGIN = "https://kichijitsu.love-rox.cc";

/**
 * リンクプレビュー画像。生成元は brand/gen-og-image.js (`pnpm --filter site gen:og`)、
 * 実体は apps/site/public/og.png → dist 直下に出る。
 *
 * クエリ (`?v=1` のようなキャッシュバスター) は付けない。ブラウザ相手の
 * wordmark.svg?v=1 と違い、読み手はクローラで、クエリ付き URL を素直に扱わない実装が
 * ありうる。差し替えたときにプレビューを更新させたい場合は各サービスのデバッガ
 * (X / Facebook 等) を叩くか、ファイル名ごと変える。
 */
const OG_IMAGE = `${SITE_ORIGIN}/og.png`;
const OG_IMAGE_ALT =
  "「思い立ったが吉日。」7つ並んだ枡のうち5つ目だけが朱で傾いている kichijitsu のブランド画像";

/** "/docs/start/index.html" → "/docs/start/" (og:url は公開 URL の形で出す) */
function pageUrl(htmlPath: string): string {
  const withSlash = htmlPath.startsWith("/") ? htmlPath : `/${htmlPath}`;
  return withSlash.replace(/index\.html$/, "");
}

/**
 * OGP / Twitter Card の**ページ共通部分**を全ページへ注入するプラグイン (2026-07-31)。
 *
 * og:title / og:description / og:type は「そのページ固有の文章」なので各 HTML に
 * 直接書く (title・meta description の隣にあった方が書き手が揃えやすい)。
 * 一方ここで入れるのは全ページで同じか、URL から機械的に決まるものだけ:
 *
 * - og:image 一式 … 無いとプレビューに画像が出ない。10ページに同じ4行を手で書くと
 *   差し替え時に必ず取りこぼすので、絶対 URL・寸法・alt をまとめて一箇所に置く
 * - twitter:card … `summary_large_image` を宣言しないと X は og:image を無視する
 * - og:url … ページごとに違うが、ビルド入力のパスから決まるので手書きの余地は無い
 *   (手で書くと 10 ページぶんのコピペでズレる。この注入なら不整合が起きえない)
 * - og:site_name / og:locale … 全ページ同一
 *
 * ページ固有の og:title 等をこちらへ寄せなかったのは、それをやると「文章がビルド設定に
 * ある」状態になり、ページを書き足す人が vite.config.ts を触る羽目になるため。
 *
 * 注入対象は rollupOptions.input の全ページで、`/docs/calendar/` のように
 * このファイルを触っていないページにも同じ共通メタが付く (漏れが構造的に起きない)。
 */
function ogpPlugin() {
  return {
    name: "kichijitsu:ogp",
    transformIndexHtml(_html: string, ctx: { path: string }) {
      const meta = (property: string, content: string) => ({
        tag: "meta",
        attrs: { property, content },
        injectTo: "head" as const,
      });
      return [
        meta("og:url", `${SITE_ORIGIN}${pageUrl(ctx.path)}`),
        meta("og:site_name", "kichijitsu"),
        meta("og:locale", "ja_JP"),
        meta("og:image", OG_IMAGE),
        meta("og:image:type", "image/png"),
        meta("og:image:width", "1200"),
        meta("og:image:height", "630"),
        meta("og:image:alt", OG_IMAGE_ALT),
        // twitter:* は property ではなく name 属性で読まれる (X の仕様)
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
          injectTo: "head" as const,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [ogpPlugin()],
  /**
   * apps/site/public/ のうち favicon.svg / wordmark.svg / icons/apple-touch-icon.png は
   * **apps/web/public/ と同じファイルの複製**。既定値と同じ "public" をあえて明示して、
   * この注意書きを置いている。
   * (og.png だけは複製ではなく site 専用。公式インスタンスのリンクプレビュー画像であり、
   *  セルフホストの成果物に入る apps/web には置かない。生成は brand/gen-og-image.js)
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
      /**
       * 追加したページはここに登録しないとビルドされない (vite のマルチページ入力は
       * 自動探索しない)。/docs/ 配下は先に全ページぶんを登録済みなので、
       * 各ページの本文を書くときにこのファイルを触る必要は無い。
       */
      input: {
        landing: r("./index.html"),
        mcp: r("./mcp/index.html"),
        selfHosting: r("./self-hosting/index.html"),
        docs: r("./docs/index.html"),
        docsStart: r("./docs/start/index.html"),
        docsCalendar: r("./docs/calendar/index.html"),
        docsWork: r("./docs/work/index.html"),
        docsBlocking: r("./docs/blocking/index.html"),
        docsApps: r("./docs/apps/index.html"),
        docsData: r("./docs/data/index.html"),
        docsOperator: r("./docs/operator/index.html"),
      },
    },
  },
});
