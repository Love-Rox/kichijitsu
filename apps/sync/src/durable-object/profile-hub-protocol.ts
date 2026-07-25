/**
 * ProfileHubDO と Worker ルート (GET /api/events) の間の**ワイヤ契約**だけを置く、実装を含まない
 * モジュール。
 *
 * profile-hub-do.ts 本体は `cloudflare:workers` (DurableObject 基底クラス) を import するため、
 * workerd の外 (= vite-plus のテスト環境、素の node) では読み込めない。この定数だけを切り出して
 * おくことで、ルート側 (routes/events.ts) を単体テストから import できる
 * (test/api-auth.test.ts が全ルートの認証適用を機械的に検査するのに必要、2026-07-25)。
 */

/**
 * GET /api/events (Worker 側ルート) が `stub.fetch(request)` で転送する際、DO 自身は
 * 自分の名前 (= profileId) を知らないので明示的にヘッダで渡す
 * ("DOs don't know their own ID" — explicit init と同じ考え方)。
 */
export const PROFILE_ID_HEADER = "X-Kichijitsu-Profile-Id";
