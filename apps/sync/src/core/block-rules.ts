import type {
  BlockMode,
  BlockRuleDTO,
  BlockRuleDeleteRequest,
  BlockRuleUpsertRequest,
} from "@kichijitsu/shared";

/** block_rules テーブルの1行 (ルール本体 + target)。source は別テーブル (BlockRuleSourceRow)。 */
export interface BlockRuleRow {
  id: string;
  profile_id: string;
  target_account_id: string;
  target_calendar_id: string;
  mode: BlockMode;
  created_at: number;
  /** 第4段階 (docs/blocking.md): 不在要求だが Workspace 非対応で busy にフォールバックしたか (0/1)。 */
  ooo_fallback: number;
}

/** block_rule_sources テーブルの1行。 */
export interface BlockRuleSourceRow {
  rule_id: string;
  account_id: string;
  calendar_id: string;
}

/** (accountId, calendarId) の組。sources/target 双方の形が同じなのでバリデーションを共有する。 */
function isValidCalendarRef(value: unknown): value is { accountId: string; calendarId: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.accountId === "string" &&
    candidate.accountId.length > 0 &&
    typeof candidate.calendarId === "string" &&
    candidate.calendarId.length > 0
  );
}

/**
 * POST /api/block-rules のボディ検証。sources は非空配列で各要素が {accountId, calendarId}
 * (非空文字列)、target は同形の単一オブジェクト、mode は 'busy'|'outOfOffice'、
 * id は無いか string (新規/更新の判定に使う)。
 */
export function isValidBlockRuleUpsertRequest(body: unknown): body is BlockRuleUpsertRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;

  if (candidate.id !== undefined && typeof candidate.id !== "string") return false;
  if (candidate.mode !== "busy" && candidate.mode !== "outOfOffice") return false;
  if (!isValidCalendarRef(candidate.target)) return false;
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) return false;
  return candidate.sources.every((source) => isValidCalendarRef(source));
}

/**
 * DELETE /api/block-rules のボディ検証。id は非空文字列、deleteMirrors は
 * 無いか boolean (文字列 "true" 等の曖昧な指定は弾く — 破壊的操作の意思表示は
 * 型で厳密に受け取る)。
 */
export function isValidBlockRuleDeleteRequest(body: unknown): body is BlockRuleDeleteRequest {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;
  if (candidate.deleteMirrors !== undefined && typeof candidate.deleteMirrors !== "boolean") {
    return false;
  }
  return typeof candidate.id === "string" && candidate.id.length > 0;
}

/**
 * DELETE /api/block-rules で「Google 側のミラー予定も消すか」を決める。
 *
 * **省略時は false (消さない)**。省略で届くリクエストは旧クライアント・MCP・手書きの
 * curl であり、そこへ「頼んでいない削除」を黙って走らせないため — 削除は常に明示的な
 * オプトインとして受け取る (shared の BlockRuleDeleteRequest.deleteMirrors のコメント参照)。
 * 設定 UI 側は既定チェック済みのチェックボックスで常に true/false を明示して送るので、
 * 「ルールを消したら効果も消える」という利用者の期待はクライアントの初期値で満たす。
 */
export function resolveDeleteMirrors(req: BlockRuleDeleteRequest): boolean {
  return req.deleteMirrors === true;
}

/**
 * POST /api/block-rules の更新経路で、既存の block_mirrors 行を捨てるべきかを判定する (純関数)。
 *
 * target (accountId または calendarId) が変わったら捨てる。対応表の行は「どの mirror event が
 * どこにあるか」を持たず rule_id で引くだけなので、target を変えたまま行を残すと
 * **古い target のカレンダーに作った event id を、新しい target のカレンダーに対して**
 * patch/delete しにいって必ず 404 になる (リコンサイルはルール単位で失敗し、新 target には
 * 何も作られないままになる)。行を捨てれば次のリコンサイルが新 target に作り直す。
 *
 * 古い target に残っているミラー予定そのものは**消さない** — 利用者が明示的に選んだときだけ
 * Google 上の予定を消す、という原則 (docs/blocking.md「後始末」)。
 *
 * previous が null (新規作成) なら捨てる行がそもそも無いので false。
 */
export function shouldDiscardMirrorRows(
  previousTarget: { accountId: string; calendarId: string } | null,
  nextTarget: { accountId: string; calendarId: string },
): boolean {
  if (!previousTarget) return false;
  return (
    previousTarget.accountId !== nextTarget.accountId ||
    previousTarget.calendarId !== nextTarget.calendarId
  );
}

/**
 * POST /api/block-rules: 保存する block_rules 1行 + block_rule_sources N行を組み立てる。
 * ルール ID は乱数を伴う (crypto.randomUUID()) ためルート側で採番し、ここへ渡す
 * (このモジュールを乱数なしの純関数に保ち、テスト可能にするため)。
 * source の重複は (accountId, calendarId) の組で排除する — block_rule_sources の PK
 * (rule_id, account_id, calendar_id) と整合させ、INSERT の衝突を避けるため。
 */
export function buildBlockRuleRows(
  ruleId: string,
  profileId: string,
  req: BlockRuleUpsertRequest,
  now: number,
): { ruleRow: BlockRuleRow; sourceRows: BlockRuleSourceRow[] } {
  const ruleRow: BlockRuleRow = {
    id: ruleId,
    profile_id: profileId,
    target_account_id: req.target.accountId,
    target_calendar_id: req.target.calendarId,
    mode: req.mode,
    created_at: now,
    ooo_fallback: 0,
  };

  const seen = new Set<string>();
  const sourceRows: BlockRuleSourceRow[] = [];
  for (const source of req.sources) {
    // 重複判定キーの区切りは U+0000 (NUL) — id に現れない文字なのでキー衝突が起きない。ソース上は
    // 生の 0x00 バイトではなくエスケープ表記で書く (生バイトを含むと git がファイルをバイナリ扱いして
    // diff が読めなくなる。文字コードは同じなので振る舞いは不変、2026-07-25)。
    const key = `${source.accountId}\u0000${source.calendarId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sourceRows.push({
      rule_id: ruleId,
      account_id: source.accountId,
      calendar_id: source.calendarId,
    });
  }

  return { ruleRow, sourceRows };
}

/**
 * GET /api/block-rules および POST の作成/更新後レスポンス用に、DB の行群を
 * BlockRuleDTO[] へ集約する。rule_id で source をグルーピングする
 * (aggregateVisibleCalendars と同じ発想)。ruleRows の順序を保つ。
 */
export function aggregateBlockRules(
  ruleRows: BlockRuleRow[],
  sourceRows: Pick<BlockRuleSourceRow, "rule_id" | "account_id" | "calendar_id">[],
): BlockRuleDTO[] {
  const sourcesByRuleId = new Map<string, { accountId: string; calendarId: string }[]>();
  for (const row of sourceRows) {
    const bucket = sourcesByRuleId.get(row.rule_id);
    const entry = { accountId: row.account_id, calendarId: row.calendar_id };
    if (bucket) {
      bucket.push(entry);
    } else {
      sourcesByRuleId.set(row.rule_id, [entry]);
    }
  }

  return ruleRows.map((rule) => ({
    id: rule.id,
    sources: sourcesByRuleId.get(rule.id) ?? [],
    target: { accountId: rule.target_account_id, calendarId: rule.target_calendar_id },
    mode: rule.mode,
    oooFallback: rule.ooo_fallback === 1,
  }));
}

/**
 * ルールが参照する全アカウント ID (source + target) の重複無し集合。所属検証
 * (このプロファイルの accountId のみを許す) の入力に使う。
 */
export function collectReferencedAccountIds(req: BlockRuleUpsertRequest): Set<string> {
  const ids = new Set<string>();
  for (const source of req.sources) {
    ids.add(source.accountId);
  }
  ids.add(req.target.accountId);
  return ids;
}
