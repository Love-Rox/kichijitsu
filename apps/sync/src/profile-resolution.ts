/**
 * /auth/callback (login モード、`?add=1` ではない通常ログイン) が「どのプロファイルに
 * ログインするか」を決めるための純関数。
 *
 * 設計 (2026-07-20, アカウント設計の分離): kichijitsu の身元 (ログイン identity = オーナー)
 * と、同期アカウント (接続 = データ源) を分ける。プロファイルは「オーナー Google
 * アカウント1つ」に紐づき、ログインは常にオーナーの OAuth でのみ確立する。
 *
 * 修正前のバグ: 「このアカウントが既にどこかの profile_id を持っていれば、それを
 * そのまま使う (= そのプロファイル全体を復活させる)」というロジックだったため、
 * `?add=1` で他人のプロファイルに接続 (is_owner=0) として足されただけのアカウントで
 * 直接ログインすると、その接続先プロファイルの束 (他の Google アカウントも含む) が
 * 丸ごと復活してしまっていた。
 *
 * 修正後: 「オーナー (is_owner=1) としてどこかのプロファイルに属しているか」だけを見る。
 * - オーナーなら: そのプロファイルへログイン (自分の身元で戻ってきた。自分の接続だけを束ねる)
 * - オーナーでない (未接続の新規アカウント、または他プロファイルの接続に過ぎない) なら:
 *   このアカウント自身をオーナーとする新規プロファイルを作る。「接続に過ぎない
 *   アカウントで他人のプロファイルを復活させる」経路をここで断つ。
 *
 * newProfileId は呼び出し側 (crypto.randomUUID()) で生成して渡す — この関数自体は
 * ランダム性に依存しない純関数のまま保つため。
 */
export interface ExistingAccountOwnership {
  profileId: string
  isOwner: boolean
}

export type LoginProfileResolution =
  | { kind: 'restore-owner-profile'; profileId: string }
  | { kind: 'new-profile'; profileId: string }

export function resolveLoginProfile(
  existing: ExistingAccountOwnership | null,
  newProfileId: string,
): LoginProfileResolution {
  if (existing?.isOwner) {
    return { kind: 'restore-owner-profile', profileId: existing.profileId }
  }
  // existing === null (初めて連携する Google アカウント) と
  // existing.isOwner === false (どこかの接続でしかない) をどちらも「新規プロファイル」に
  // まとめる — login モードでは「オーナーかどうか」だけが分岐条件であり、
  // 「接続として既知かどうか」はプロファイル解決に影響しない。
  return { kind: 'new-profile', profileId: newProfileId }
}

/**
 * migration 0004 の「各 profile_id グループで最古 (created_at 最小、同着なら id 昇順) の
 * アカウントを owner とする」という移行ルールを TypeScript 側でも表現した純関数。
 * 実際の移行は D1 上で生の SQL (migrations/0004_owner.sql) として実行されるため、この
 * 関数自体は本番の移行処理には使われないが、ルールの意図をテストで固定するために置く
 * (SQL 側のロジックと乖離しないよう、変更時は両方を見直すこと)。
 */
export interface OwnerCandidate {
  id: string
  createdAt: number
}

export function selectOwnerAccountId(accounts: readonly OwnerCandidate[]): string | null {
  if (accounts.length === 0) return null
  return accounts.reduce((owner, candidate) => {
    if (candidate.createdAt < owner.createdAt) return candidate
    if (candidate.createdAt === owner.createdAt && candidate.id < owner.id) return candidate
    return owner
  }).id
}
