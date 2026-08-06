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
 *   ただし、呼び出し側が「その接続先プロファイルには現在オーナーが1人もいない」ことを
 *   確認できている場合は `promote-to-owner` を返す (2026-08-06、下記参照)。
 *
 * newProfileId は呼び出し側 (crypto.randomUUID()) で生成して渡す — この関数自体は
 * ランダム性に依存しない純関数のまま保つため。
 *
 * --- 2026-08-06 の追加修正: オーナー不在プロファイルからのセルフ復旧 ---
 *
 * 本番で2回、「あるプロファイルのオーナーが is_owner=0 に降格し、オーナー不在の
 * プロファイルができる」事故が起きた (直接の原因は routes/auth.ts の UPSERT が
 * add モードで既存オーナー行を上書きしていたこと。これ自体は auth.ts 側の UPSERT を
 * 修正済み)。オーナー不在になると、上の分岐ルールでは**そのプロファイルの誰も二度と
 * ログインできない** (接続アカウントは常に reject-connection-login) ため、D1 を直接
 * 触る以外に復旧手段が無かった。
 *
 * そこで、接続アカウント (isOwner === false) でのログイン試行時に「その接続先
 * プロファイルに現在オーナーが1人もいない」ことが確認できた場合に限り、ログインを
 * 許可してそのアカウントをオーナーに昇格させる (`promote-to-owner`)。呼び出し側は
 * このとき `state.mode !== "add"` なので isOwner=1 で UPSERT され、実際に昇格する
 * (routes/auth.ts 参照)。
 *
 * **2026-07-21 の事故を再発させないと言える理由**: 2026-07-21 の事故は「接続
 * アカウントでのログインが、別プロファイルの束を丸ごと新プロファイルへ引き剥がす
 * (= 他のプロファイルを破壊する)」ことだった。今回の `promote-to-owner` は
 * - オーナーが**存在する**プロファイルへの接続アカウントログインは今までどおり
 *   reject-connection-login のまま (呼び出し側は「オーナー不在」を確認できた
 *   ときだけ true を渡す設計にする) ―― 健全なプロファイルの isOwner を書き換える
 *   経路は一切増えない。
 * - 昇格は「そのアカウントが元々属していた同じ profile_id」の中で is_owner フラグを
 *   0→1 にするだけで、profile_id 自体は変更しない・新規プロファイルも作らない・
 *   他のアカウント行にも一切触れない。つまり「別のプロファイルを巻き込む」余地が
 *   構造的に無い (2026-07-21 のバグの本質だった「束の引き剥がし」が起こり得ない)。
 * したがって「異なるプロファイル間でアカウントを移動させる/束を破壊する」という
 * 2026-07-21 のバグのパターンには当てはまらない。
 */
export interface ExistingAccountOwnership {
  profileId: string;
  isOwner: boolean;
}

export type LoginProfileResolution =
  | { kind: "restore-owner-profile"; profileId: string }
  | { kind: "new-profile"; profileId: string }
  | { kind: "promote-to-owner"; profileId: string }
  | { kind: "reject-connection-login" };

/**
 * @param connectedProfileHasNoOwner `existing.isOwner === false` のときだけ意味を持つ。
 *   呼び出し側が `existing.profileId` に属する全アカウントを見て
 *   `isProfileOwnerless` で判定した結果を渡す (この関数自体は D1 を見ないので、
 *   判定結果を注入してもらう形にしてある)。省略時は false 扱い = 常に拒否
 *   (これまでどおりの安全側)。
 */
export function resolveLoginProfile(
  existing: ExistingAccountOwnership | null,
  newProfileId: string,
  connectedProfileHasNoOwner = false,
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
  // アカウント行も一切変更せず、呼び出し側にログイン拒否を委ねる ―― ただし、
  // その接続先プロファイルに現在オーナーが1人もいないと確認できているなら、
  // 唯一の例外としてこのアカウントをそのプロファイルのオーナーに昇格させてログインを
  // 許す (2026-08-06、上記コメント参照。他プロファイルへは一切波及しない)。
  if (connectedProfileHasNoOwner) {
    return { kind: "promote-to-owner", profileId: existing.profileId };
  }
  return { kind: "reject-connection-login" };
}

/**
 * accounts テーブルの1行から「オーナー不在プロファイル検出」に必要な最小情報。
 * D1 の行 (id, profile_id, is_owner) をそのまま渡せる形にはせず、判定に要る
 * profileId/isOwner だけを持たせている (呼び出し側で row.is_owner === 1 に変換する)。
 */
export interface AccountOwnershipRow {
  profileId: string;
  isOwner: boolean;
}

/**
 * 「同じプロファイルに属するアカウント行の集合」を渡し、その中にオーナー
 * (isOwner === true) が1人もいなければ true を返す純関数。
 *
 * 空配列 (= そのプロファイルにアカウントが1件も無い) は false 扱い ―― そもそも
 * 存在しないプロファイルであり、「オーナー不在」として復旧を試みる対象ではない
 * (findOwnerlessProfileIds は accounts 全体から実在する profile_id だけを見るので、
 * この関数を直接使う場合も呼び出し側は実在する profile_id の行に絞って渡すこと)。
 *
 * accounts (profile_id) WHERE is_owner = 1 の部分ユニークインデックスは「オーナーは
 * 多くとも1人」しか保証しないため (0件は許される)、「ちょうど1人」であることは
 * こちらのコード側で検出する必要がある ―― この関数がその検出ロジック本体。
 */
export function isProfileOwnerless(
  accounts: readonly Pick<AccountOwnershipRow, "isOwner">[],
): boolean {
  return accounts.length > 0 && accounts.every((account) => !account.isOwner);
}

/**
 * accounts テーブル全体 (複数プロファイルにまたがってよい) から、オーナー不在の
 * profile_id 一覧を求める。運用時の調査・監視や、将来ダッシュボードに出す用途を
 * 想定した汎用版 (routes/auth.ts の昇格判定は単一プロファイルだけ見れば十分なので
 * isProfileOwnerless を直接使う)。
 */
export function findOwnerlessProfileIds(accounts: readonly AccountOwnershipRow[]): string[] {
  const byProfile = new Map<string, AccountOwnershipRow[]>();
  for (const account of accounts) {
    const bucket = byProfile.get(account.profileId);
    if (bucket) {
      bucket.push(account);
    } else {
      byProfile.set(account.profileId, [account]);
    }
  }
  const ownerless: string[] = [];
  for (const [profileId, rows] of byProfile) {
    if (isProfileOwnerless(rows)) ownerless.push(profileId);
  }
  return ownerless;
}

/**
 * add モード (`?add=1`、routes/auth.ts の /auth/callback) で選んだ Google アカウントが
 * 「今追加しようとしているプロファイルとは別のプロファイルのオーナー」かどうかを判定する
 * 純関数 (2026-08-07)。
 *
 * 背景: accounts.id (= Google sub) は PK なので、1つの Google アカウントは常にどこか
 * 1つのプロファイルにしか属せない。add モードの UPSERT (ACCOUNTS_UPSERT_SQL) は
 * `profile_id = excluded.profile_id` で無条件に上書きするため、既に別プロファイル A の
 * オーナーであるアカウントを、プロファイル B へ「+ アカウントを追加」しようとすると、
 * その行を A から B へ引き剥がしてしまう。これには2通りの実害がある:
 * - B に既にオーナーがいる場合: is_owner は `MAX(is_owner, excluded.is_owner)` で
 *   既存値 (1) を維持するため、B に is_owner=1 の行が2つできて部分ユニークインデックス
 *   `idx_accounts_one_owner_per_profile` に衝突し、例外 → 生の 500 になる
 *   (このバグ自体のきっかけ)。
 * - B にオーナーがいない場合: 衝突せず成功するが、元のプロファイル A がオーナー不在に
 *   なり、A の側で誰もログインできなくなる (2026-08-06 修正前に実際に本番で起きた事故で、
 *   衝突する/しないに関わらずこの「元プロファイルを壊す」実害は同じ)。
 *
 * この関数は上記どちらのケースも「B が現在オーナーを持っているか」を見ずに一律で検出する
 * ―― UPSERT や UNIQUE 制約のエラーに頼らず、SQL を実行する前に呼び出し側で弾くための
 * 事前チェックとして使う (制約違反のメッセージ文字列に依存すると SQLite の実装詳細に
 * 結合してしまい壊れやすいため)。
 *
 * **同じプロファイルのオーナーを選び直した場合 (targetProfileId === existingProfileId) は
 * 衝突とみなさない** ―― これは「再認証」ボタン (常に add モードで遷移する) がオーナー
 * 自身のアカウントを選び直す正当な経路であり、2026-08-06 に別の事故 (is_owner の
 * 1→0 降格) を修正したばかりの経路でもある。ここを一緒に弾くと、その修正を無に
 * 帰してしまう。
 */
export interface AddModeOwnerConflictCheck {
  /** 選ばれた Google アカウントが現在オーナーになっているプロファイル ID (accounts.profile_id)。 */
  existingProfileId: string;
  /** 選ばれた Google アカウントが現在オーナーかどうか (accounts.is_owner === 1)。 */
  existingIsOwner: boolean;
  /** 今回の add モードでアカウントを追加しようとしているプロファイル ID (state.profileId)。 */
  targetProfileId: string;
}

export function isAddModeOwnerConflict(check: AddModeOwnerConflictCheck): boolean {
  return check.existingIsOwner && check.existingProfileId !== check.targetProfileId;
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
