-- アカウント設計の分離 (2026-07-20): kichijitsu の身元 (ログイン identity = オーナー) と
-- 同期アカウント (接続 = データ源) を分ける。
--
-- 背景のバグ: これまで「プロファイル (=セッション) = 複数 Google アカウントの束」で、
-- 束に属するどのアカウントでログインしても束全体が復活していた。スマホで片方の
-- アカウントでログインすると、PC で ?add=1 で追加しただけの別アカウントまで一緒に
-- 同期されてしまう (プライバシー/取り違えのリスク)。
--
-- 修正方針: プロファイルは「オーナー Google アカウント1つ」に紐づく。ログイン
-- (/auth/callback, add でない) は常にオーナーの OAuth でのみ成立させ、`?add=1` で
-- 足したアカウントは is_owner=0 の「接続」として区別する。ロジック本体は
-- src/routes/auth.ts (プロファイル解決) と src/profile-resolution.ts (純関数) 側。
ALTER TABLE accounts ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

-- 既存データの移行: 各 profile_id グループ (= 既存の束) で最古 (created_at 最小、
-- 同着なら id 昇順で決定的に1件選ぶ) のアカウントを owner=1 にする。
-- 既存の束の profile_id 自体は一切変更しない (壊さない) — あくまで「その束の中で
-- 誰が身元か」を事後的にマークするだけ。運用時点ではテストユーザーのダミーデータ
-- しか無いが、素朴に「最初に連携した (= 恐らく後から ?add=1 で足した側ではない)
-- アカウント」をオーナーとみなす方針で十分と判断した。
UPDATE accounts
SET is_owner = 1
WHERE id IN (
  SELECT a.id
  FROM accounts a
  WHERE a.created_at = (
    SELECT MIN(b.created_at) FROM accounts b WHERE b.profile_id = a.profile_id
  )
  AND a.id = (
    SELECT MIN(c.id) FROM accounts c WHERE c.profile_id = a.profile_id AND c.created_at = a.created_at
  )
);

-- 1 プロファイルにつきオーナーは高々1人であることを DB レベルでも保証する
-- (部分ユニークインデックス: is_owner = 1 の行だけを対象にする)。
CREATE UNIQUE INDEX idx_accounts_one_owner_per_profile ON accounts (profile_id) WHERE is_owner = 1;
