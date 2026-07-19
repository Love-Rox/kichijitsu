/**
 * リクエストが HTTPS 経由かどうか。
 *
 * Cookie の Secure 属性の可否判定に使う。ローカル `wrangler dev` は素の HTTP なので、
 * Secure を無条件に付けると (localhost を特別扱いしないブラウザ/HTTP クライアントでは)
 * ブラウザが Cookie を保存/送信しなくなる。本番は Cloudflare が TLS を終端した上で
 * Worker に渡すリクエストの URL は https: を反映するため、`req.url` のスキームで
 * 判定すれば dev/prod を自動で切り替えられる。
 */
export function isHttpsRequest(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === 'https:'
}
