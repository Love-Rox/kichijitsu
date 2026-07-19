import type { DisconnectRequest } from '@kichijitsu/shared'

/**
 * 指定した account 行 (D1 から引いた profile_id だけを持つ行) が、そのプロファイルに
 * 属しているか。null (= そもそも存在しない accountId) は false。
 *
 * 他人のプロファイルの accountId を指定されても触らない、という要件をここで一元的に
 * 判定する。呼び出し側は D1 で `SELECT profile_id FROM accounts WHERE id = ?` した
 * 結果をそのまま渡すだけでよい。
 */
export function isAccountInProfile(account: { profile_id: string } | null, profileId: string): boolean {
  return account !== null && account.profile_id === profileId
}

/**
 * DELETE /api/account の対象 accountId 群を決める。
 * - body.accountId 指定あり: そのアカウントがプロファイルに属していなければ null (= 403 相当)
 * - body.accountId 省略: プロファイル内の全アカウント
 */
export function resolveDisconnectTargets(request: DisconnectRequest, profileAccountIds: string[]): string[] | null {
  if (request.accountId) {
    return profileAccountIds.includes(request.accountId) ? [request.accountId] : null
  }
  return profileAccountIds
}

/** 削除後にプロファイルへ紐づくアカウントが0件になるならセッションも破棄する。 */
export function shouldClearSessionAfterDisconnect(remainingAccountCount: number): boolean {
  return remainingAccountCount === 0
}
