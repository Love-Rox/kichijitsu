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

/** DELETE /api/account の対象決定に使う、プロファイル内アカウントの最小情報。 */
export interface AccountMembership {
  id: string
  isOwner: boolean
}

/**
 * DELETE /api/account の対象 accountId 群を決める。
 * - body.accountId 指定あり:
 *   - そのアカウントがプロファイルに属していなければ null (= 403 相当)
 *   - 対象がオーナーアカウントなら、プロファイル全体の解除に格上げする (安全側)。
 *     オーナー (= このプロファイルの身元) だけを消して接続アカウントだけが残る
 *     宙ぶらりん状態 (誰のプロファイルか分からなくなる) を防ぐため。「次に古い接続を
 *     オーナーに昇格する」という選択肢もあり得るが、本人の意図しない相手を勝手に
 *     オーナーへ格上げするのは越権になるので採らない — 安全側 = 全解除、とする。
 *   - 対象が接続アカウント (isOwner=false) ならそのアカウントだけ (従来どおり)
 * - body.accountId 省略: プロファイル内の全アカウント (従来どおり)
 */
export function resolveDisconnectTargets(request: DisconnectRequest, profileAccounts: AccountMembership[]): string[] | null {
  if (request.accountId) {
    const target = profileAccounts.find((account) => account.id === request.accountId)
    if (!target) return null
    if (target.isOwner) {
      return profileAccounts.map((account) => account.id)
    }
    return [request.accountId]
  }
  return profileAccounts.map((account) => account.id)
}

/** 削除後にプロファイルへ紐づくアカウントが0件になるならセッションも破棄する。 */
export function shouldClearSessionAfterDisconnect(remainingAccountCount: number): boolean {
  return remainingAccountCount === 0
}
