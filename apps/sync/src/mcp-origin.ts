/**
 * MCP エンドポイント (`/mcp`) の Origin 検証。DNS リバインディング対策として
 * MCP 仕様がトランスポート層で要求している MUST を満たすための純関数。
 *
 * 仕様 (2025-11-25 / 2026-07-28 いずれの Streamable HTTP でも同文):
 *   "Servers MUST validate the Origin header on all incoming connections to prevent
 *    DNS rebinding attacks. If the Origin header is present and invalid, servers MUST
 *    respond with HTTP 403 Forbidden."
 *
 * なぜ「Origin が無ければ通す」のか:
 * 条件は「present and invalid」であって「missing」ではない。Origin はブラウザが
 * 自動付与するヘッダで、Claude Desktop / Claude Code のような非ブラウザ MCP
 * クライアントは付けない — ここで「Origin 必須」にすると既存クライアントが全滅する。
 * 攻撃モデル (悪意あるサイトが被害者のブラウザ経由でローカル/内部サーバーを叩く) では
 * Origin は必ず付くので、「付いている場合だけ検証する」で防御は成立する。
 *
 * なぜ同一オリジンと localhost だけ許すのか:
 * kichijitsu の /mcp をブラウザから正当に呼ぶのは自分自身のページだけで、
 * サードパーティ製のブラウザ内 MCP クライアントは想定していない。localhost を
 * 許すのはローカルの `wrangler dev` 検証のため (本番ホストのページから
 * localhost:8787 を叩くことはないので、本番の防御は緩まない)。
 */

/**
 * ホスト名が loopback (localhost / 127.0.0.1 / [::1]) かどうか。ポートは問わない。
 *
 * `URL.hostname` は IPv6 をブラケット付き (`[::1]`) で返すため、ブラケットを外してから
 * 比較する (`new URL("http://[::1]:8787").hostname === "[::1]"`)。
 */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/**
 * `Origin` ヘッダ値がこの MCP エンドポイントへのアクセスを許されたオリジンか判定する。
 *
 * @param origin      リクエストの `Origin` ヘッダ (無ければ undefined / null)
 * @param requestUrl  リクエスト自身の URL (同一オリジン判定の基準)
 * @returns 通してよければ true、403 で拒否すべきなら false
 */
export function isAllowedMcpOrigin(
  origin: string | null | undefined,
  requestUrl: string,
): boolean {
  // Origin 非送出 (= 非ブラウザクライアント) は検証対象外。上のコメント参照。
  if (origin === null || origin === undefined || origin === "") return true;

  // `Origin: null` (sandboxed iframe / opaque origin) は素性を確認できないので拒否する。
  if (origin === "null") return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    // パースできない Origin は不正。
    return false;
  }

  // 同一オリジン (scheme + host + port が一致) なら許可。
  const target = new URL(requestUrl);
  if (originUrl.origin === target.origin) return true;

  // ローカル開発 (`wrangler dev` + 検証用プロキシ) 用に loopback を許可する。
  return isLoopbackHostname(originUrl.hostname);
}
