-- 連携解除の取りこぼしで残った孤児行の掃除 (2026-07-28)。
--
-- DELETE /api/account はこれまで認可情報・表示カレンダー選択・DO の同期状態しか消しておらず、
-- 解除済みアカウントを参照する watches / block_rules / block_rule_sources / block_mirrors が
-- 残り続けていた。ルート側は core/account-disconnect.ts で直したが、既に残っている行は
-- そのままなのでここで一度だけ掃除する。
--
-- 孤児の判定は「accounts に存在しない account_id を参照している行」で行う。これらのテーブルには
-- 外部キー制約が無い (0003/0006 参照) ため参照整合性は保たれておらず、accounts への NOT IN が
-- 唯一の手掛かりになる。accounts の行は連携解除でのみ消えるので、これは「解除済みアカウントを
-- 参照する行」と同義。
--
-- 注意: watches 行を消しても Google 側の push 購読そのものは止まらない (channels.stop には
-- access token が要り、SQL からは呼べない)。ただし残った購読の通知先である
-- POST /api/webhook/google は channel_id で watches を引けず何もしないので実害は無く、
-- 購読自体も Google 側の有効期限 (最大でも数日〜1か月) で自然に切れる。

-- 1. 解除済みアカウントの watch 行。放置すると Cron の renewWatch (src/index.ts) が
--    存在しないアカウントの watch を6時間おきに再登録しようとして失敗し続ける。
DELETE FROM watches WHERE account_id NOT IN (SELECT id FROM accounts);

-- 2. target が解除済みのブロックルール。書き込み先が無いのでルールとして成立しない。
DELETE FROM block_rules WHERE target_account_id NOT IN (SELECT id FROM accounts);

-- 3. source が解除済みの参照。ルール本体は (他の source が残るなら) 残す — 実装側の
--    planBlockRuleCleanup と同じ判断。あわせて、2 で消えたルールにぶら下がる source も消す。
DELETE FROM block_rule_sources WHERE account_id NOT IN (SELECT id FROM accounts);
DELETE FROM block_rule_sources WHERE rule_id NOT IN (SELECT id FROM block_rules);

-- 4. 3 の結果 source が0件になったルール。source の無いルールは何もブロックしないので消す。
DELETE FROM block_rules WHERE id NOT IN (SELECT rule_id FROM block_rule_sources);

-- 5. 消えたルールの mirror 対応表。Google 側に残っているミラー予定はここからは触れない
--    (対象アカウントの認可が既に revoke されているため原理的に消せない) — 孤児予定の扱いは
--    別途検討する。
DELETE FROM block_mirrors WHERE rule_id NOT IN (SELECT id FROM block_rules);
