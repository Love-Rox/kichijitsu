/**
 * /auth/callback (login モード、`?add=1` ではない通常ログイン) が「どのプロファイルに
 * ログインするか」を決めるための純関数。
 *
 * 設計 (2026-07-20, アカウント設計の分離): kichijitsu の身元 (ログイン identity = オーナー)
 * と、同期アカウント (接続 = データ源) を分ける。プロファイルは「オーナー Google
 * アカウント1つ」に紐づき、ログインは常にオーナーの OAuth でのみ確立する。
 *
 * 2026-07-20 のバグ: 「このアカウントが既にどこかの profile_id を持っていれば、それを
 * そのまま使う (= そのプロファイル全体を復活させる)」というロジックだったため、
 * `?add=1` で他人のプロファイルに接続 (is_owner=0) として足されただけのアカウントで
 * 直接ログインすると、その接続先プロファイルの束 (他の Google アカウントも含む) が
 * 丸ごと復活してしまっていた。この修正で「オーナーかどうか」だけを見るように変えたが、
 * 「オーナーでないなら新規プロファイルを作る」という次の一手にも別の欠陥が残っていた
 * (下記 2026-07-21 参照)。
 *
 * 2026-07-21 の再修正 (このバグの本体): 「オーナーでないなら新規プロファイルを作る」は
 * 一見安全に見えるが、`auth.ts` の呼び出し側では `new-profile` 決定後に accounts 行を
 * `ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, is_owner = excluded.is_owner`
 * で UPSERT していた。accounts.id (= Google sub) は PK なので、この UPSERT は「既存の
 * 接続アカウント行」を元プロファイルから新プロファイルへ**引き剥がして**しまう。結果、
 * 元プロファイル (別端末でログイン中かもしれない) はそのアカウントを失いカレンダーが
 * 消え、新端末は空プロファイルになる、という実害が本番で発生した。
 *
 * 修正後: 既存アカウントの所属関係を見て、次の3通りに分岐する。
 * - existing === null (初めて見る Google アカウント): このアカウント自身をオーナーと
 *   する新規プロファイルを作る (`new-profile`)。
 * - existing.isOwner === true (どこかのプロファイルのオーナー): そのプロファイルへ
 *   ログインする (`restore-owner-profile`。自分の身元で戻ってきた)。
 * - existing.isOwner === false (どこかのプロファイルに接続として属するだけ):
 *   プロファイルを作らず・アカウント行も一切書き換えず、ログインを拒否する
 *   (`reject-connection-login`)。呼び出し側 (auth.ts) はこの場合、ユーザーへ
 *   「オーナーアカウントでログインしてほしい」旨のエラーページを返す。
 *
 * newProfileId は呼び出し側 (crypto.randomUUID()) で生成して渡す — この関数自体は
 * ランダム性に依存しない純関数のまま保つため。
 */
export interface ExistingAccountOwnership {
  profileId: string;
  isOwner: boolean;
}

export type LoginProfileResolution =
  | { kind: "restore-owner-profile"; profileId: string }
  | { kind: "new-profile"; profileId: string }
  | { kind: "reject-connection-login" };

export function resolveLoginProfile(
  existing: ExistingAccountOwnership | null,
  newProfileId: string,
): LoginProfileResolution {
  if (existing === null) {
    return { kind: "new-profile", profileId: newProfileId };
  }
  if (existing.isOwner) {
    return { kind: "restore-owner-profile", profileId: existing.profileId };
  }
  // existing.isOwner === false: 他プロファイルへの接続に過ぎないアカウント。
  // ここで安易に新規プロファイルを作ると、呼び出し側の UPSERT がこのアカウント行を
  // 元プロファイルから引き剥がしてしまう (2026-07-21 のバグ本体)。プロファイルも
  // アカウント行も一切変更せず、呼び出し側にログイン拒否を委ねる。
  return { kind: "reject-connection-login" };
}

/**
 * migration 0004 の「各 profile_id グループで最古 (created_at 最小、同着なら id 昇順) の
 * アカウントを owner とする」という移行ルールを TypeScript 側でも表現した純関数。
 * 実際の移行は D1 上で生の SQL (migrations/0004_owner.sql) として実行されるため、この
 * 関数自体は本番の移行処理には使われないが、ルールの意図をテストで固定するために置く
 * (SQL 側のロジックと乖離しないよう、変更時は両方を見直すこと)。
 */
export interface OwnerCandidate {
  id: string;
  createdAt: number;
}

export function selectOwnerAccountId(accounts: readonly OwnerCandidate[]): string | null {
  if (accounts.length === 0) return null;
  return accounts.reduce((owner, candidate) => {
    if (candidate.createdAt < owner.createdAt) return candidate;
    if (candidate.createdAt === owner.createdAt && candidate.id < owner.id) return candidate;
    return owner;
  }).id;
}
