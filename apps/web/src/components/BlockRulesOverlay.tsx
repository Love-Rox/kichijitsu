import { useRef, useState } from "react";
import type {
  AccountDTO,
  BlockMode,
  BlockRuleDTO,
  BlockRuleUpsertRequest,
  CalendarListEntryDTO,
} from "@kichijitsu/shared";
import { buildBlockRuleUpsertRequest, describeBlockRule } from "../sync/blockRules";
import { calendarKey } from "../layout/keys";
import { removeFromSet, toggleSetMember } from "../layout/setOps";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./BlockRulesOverlay.css";

export interface BlockRulesOverlayProps {
  accounts: AccountDTO[];
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  rules: BlockRuleDTO[];
  /** 成功で解決/失敗で reject する。エラー表示はこのコンポーネントが持つ */
  onCreate: (req: BlockRuleUpsertRequest) => Promise<void>;
  /** deleteMirrors = 確認 UI のチェックボックスの値(作成済みのブロック予定も消すか) */
  onDelete: (id: string, deleteMirrors: boolean) => Promise<void>;
  onClose: () => void;
}

/**
 * カレンダーブロック設定オーバーレイ(フェーズ7 第1段階の UI 部分、docs/blocking.md)。
 * 設定パネル(300px)には収まらないため、SearchOverlay/KeyboardHelpOverlay と同じ
 * 「App.tsx が開閉制御し、このコンポーネントは常に開いている前提で描画する」役割分担の
 * 専用オーバーレイに切り出す。閉じ方(Escape・外側クリック)は useCloseOnOutsideOrEscape で
 * 他のオーバーレイと揃える。ここでは作成/一覧/削除の配線のみを扱い、mirror 生成や
 * Busy ハッチでの自動生成ブロック表示、outOfOffice の実 Workspace 判定は対象外(後段)。
 */
export function BlockRulesOverlay({
  accounts,
  calendarsByAccount,
  rules,
  onCreate,
  onDelete,
  onClose,
}: BlockRulesOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  return (
    <div className="block-rules-backdrop">
      <div className="block-rules-card" ref={cardRef} role="dialog" aria-label="予定のブロック">
        <div className="block-rules-header">
          <span className="block-rules-title">予定のブロック</span>
          <button type="button" className="block-rules-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <p className="block-rules-description">
          選んだカレンダーの予定を、別のカレンダーに「予定あり」として自動でコピーします。会議の空き時間を他の人から見えるようにするのに使えます。
        </p>

        <section className="block-rules-section">
          <h3 className="block-rules-section-title">設定済みのルール</h3>
          <RuleList rules={rules} calendarsByAccount={calendarsByAccount} onDelete={onDelete} />
        </section>

        <section className="block-rules-section">
          <h3 className="block-rules-section-title">ルールを追加</h3>
          <NewRuleForm
            accounts={accounts}
            calendarsByAccount={calendarsByAccount}
            onCreate={onCreate}
          />
        </section>
      </div>
    </div>
  );
}

interface RuleListProps {
  rules: BlockRuleDTO[];
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  onDelete: (id: string, deleteMirrors: boolean) => Promise<void>;
}

function RuleList({ rules, calendarsByAccount, onDelete }: RuleListProps) {
  if (rules.length === 0) {
    return <p className="block-rules-empty">まだブロックルールはありません</p>;
  }

  return (
    <ul className="block-rules-list">
      {rules.map((rule) => {
        const info = describeBlockRule(rule, calendarsByAccount);
        return (
          <li className="block-rules-rule" key={rule.id}>
            <span className="block-rules-rule-summary">
              <span className="block-rules-rule-sources">{info.sourceNames.join("、")}</span>
              <span className="block-rules-rule-arrow" aria-hidden="true">
                →
              </span>
              <span className="block-rules-rule-target">{info.targetName}</span>
            </span>
            <span
              className={
                rule.mode === "outOfOffice"
                  ? "block-rules-badge block-rules-badge--ooo"
                  : "block-rules-badge"
              }
            >
              {info.modeLabel}
            </span>
            {info.oooFallback && (
              <span className="block-rules-mode-note block-rules-mode-note--inline">
                不在に非対応のため「予定あり」で作成しています
              </span>
            )}
            <RuleDeleteControl
              ruleId={rule.id}
              label={`${info.sourceNames.join("、")}から${info.targetName}へのルール`}
              targetName={info.targetName}
              onDelete={onDelete}
            />
          </li>
        );
      })}
    </ul>
  );
}

type RuleDeleteState = "idle" | "confirming" | "deleting" | "error";

/**
 * ルール1件ぶんの削除導線。window.confirm を使わないインライン2段階確認
 * (settings/ConfirmActionControl.tsx / EventDetailCard の削除と同じ流儀) に、
 * 「作成済みのブロック予定も削除する」チェックボックスを足したもの。
 *
 * **共通部品へは畳んでいない**: 確認の中にチェックボックスと、その状態で文が変わる注記を
 * 抱えており (下記)、実行ボタンのラベルも「削除中…」に変わる。縦積み (CSS も
 * flex-direction: column) なのもここだけ。理由の詳細は
 * settings/ConfirmActionControl.tsx の冒頭コメント (適用範囲) を参照。
 *
 * チェックボックスの**既定は on**: ルールを消したら効果も消えるのが素直で、かつ利用者の
 * 目の前にあるので外せる。外した場合はコピー先に作られた「予定あり」がそのまま残る
 * (サーバー側の既定は逆に「消さない」―― 省略で届くリクエストに黙って削除を走らせない
 * ため。sync/blockRules.ts の buildBlockRuleDeleteRequest 参照)。
 *
 * 状態は行ごとのローカル state として持つ (他の行の確認表示に影響しない)。
 */
function RuleDeleteControl({
  ruleId,
  label,
  targetName,
  onDelete,
}: {
  ruleId: string;
  /** 読み上げ用のルールの説明 (「〜から〜へのルール」) */
  label: string;
  targetName: string;
  onDelete: (id: string, deleteMirrors: boolean) => Promise<void>;
}) {
  const [state, setState] = useState<RuleDeleteState>("idle");
  const [deleteMirrors, setDeleteMirrors] = useState(true);

  if (state === "confirming" || state === "deleting") {
    const checkboxId = `block-rules-delete-mirrors-${ruleId}`;
    return (
      <span className="block-rules-rule-confirm">
        <span className="block-rules-confirm-question">{label}を削除しますか？</span>
        <label className="block-rules-confirm-check" htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={deleteMirrors}
            disabled={state === "deleting"}
            onChange={(e) => setDeleteMirrors(e.target.checked)}
          />
          作成済みのブロック予定も削除する
        </label>
        <span className="block-rules-confirm-note">
          {deleteMirrors
            ? `${targetName}に作った「予定あり」を Google カレンダーから削除します`
            : `${targetName}に作った「予定あり」は Google カレンダーに残ります`}
        </span>
        <span className="block-rules-confirm-actions">
          <button
            type="button"
            className="block-rules-text-btn"
            disabled={state === "deleting"}
            onClick={() => {
              setState("deleting");
              onDelete(ruleId, deleteMirrors).catch((err) => {
                console.error("kichijitsu: block rule delete failed", err);
                setState("error");
              });
              // 成功時は呼び出し元 (useBlockRules) が一覧から本行ごと除去するので
              // ここでの idle 復帰は不要
            }}
          >
            {state === "deleting" ? "削除中…" : "削除する"}
          </button>
          <button
            type="button"
            className="block-rules-text-btn"
            disabled={state === "deleting"}
            onClick={() => setState("idle")}
          >
            やめる
          </button>
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="block-rules-rule-delete"
        aria-label={`${label}を削除`}
        onClick={() => setState("confirming")}
      >
        ×
      </button>
      {state === "error" && <span className="block-rules-error">削除に失敗しました</span>}
    </>
  );
}

interface CalendarOption {
  key: string;
  accountId: string;
  calendarId: string;
  name: string;
  color?: string;
}

interface AccountGroup {
  account: AccountDTO;
  options: CalendarOption[];
}

function buildGroups(
  accounts: AccountDTO[],
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>,
): AccountGroup[] {
  return accounts.map((account) => ({
    account,
    options: (calendarsByAccount[account.id] ?? []).map((cal) => ({
      key: calendarKey(account.id, cal.id),
      accountId: account.id,
      calendarId: cal.id,
      name: cal.summary,
      color: cal.backgroundColor,
    })),
  }));
}

interface NewRuleFormProps {
  accounts: AccountDTO[];
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  onCreate: (req: BlockRuleUpsertRequest) => Promise<void>;
}

function NewRuleForm({ accounts, calendarsByAccount, onCreate }: NewRuleFormProps) {
  // ReadonlySet で持つのは layout/setOps.ts の removeFromSet/toggleSetMember をそのまま
  // setState に渡せるようにするため(App.tsx の tasksScopeMissingAccounts と同じ流儀)
  const [sourceKeys, setSourceKeys] = useState<ReadonlySet<string>>(new Set());
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [mode, setMode] = useState<BlockMode>("busy");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = buildGroups(accounts, calendarsByAccount);
  const hasAnyCalendar = groups.some((g) => g.options.length > 0);

  function toggleSource(key: string) {
    setSourceKeys((prev) => toggleSetMember(prev, key));
    // source として選んだカレンダーは target から外す(同一カレンダーを両方にできない制約)
    if (targetKey === key) setTargetKey(null);
  }

  function selectTarget(key: string) {
    setTargetKey(key);
    // target として選んだカレンダーは source から外す
    // (removeFromSet は元々含まないなら同じ参照を返すので、無駄な再レンダーも起きない)
    setSourceKeys((prev) => removeFromSet(prev, key));
  }

  const canSave = sourceKeys.size > 0 && targetKey !== null;

  function handleSave() {
    if (!canSave || !targetKey) return;
    const sources = [...sourceKeys].map((key) => {
      const [accountId, calendarId] = splitKey(key);
      return { accountId, calendarId };
    });
    const [targetAccountId, targetCalendarId] = splitKey(targetKey);
    const req = buildBlockRuleUpsertRequest(
      sources,
      { accountId: targetAccountId, calendarId: targetCalendarId },
      mode,
    );

    setSubmitting(true);
    setError(null);
    onCreate(req)
      .then(() => {
        setSourceKeys(new Set());
        setTargetKey(null);
        setMode("busy");
      })
      .catch((err) => {
        console.error("kichijitsu: block rule create failed", err);
        setError("保存に失敗しました。しばらくしてから試してください");
      })
      .finally(() => setSubmitting(false));
  }

  if (!hasAnyCalendar) {
    return <p className="block-rules-empty">カレンダーを読み込み中、または取得できませんでした</p>;
  }

  return (
    <div className="block-rules-form">
      <div className="block-rules-field">
        <span className="block-rules-field-label">コピー元(複数選択できます)</span>
        {groups.map((group) => (
          <CalendarGroup
            key={group.account.id}
            group={group}
            selectionKind="checkbox"
            isSelected={(key) => sourceKeys.has(key)}
            isDisabled={(key) => key === targetKey}
            onSelect={toggleSource}
          />
        ))}
      </div>

      <div className="block-rules-field">
        <span className="block-rules-field-label">コピー先(1つ選びます)</span>
        <div role="radiogroup" aria-label="コピー先カレンダー">
          {groups.map((group) => (
            <CalendarGroup
              key={group.account.id}
              group={group}
              selectionKind="radio"
              isSelected={(key) => targetKey === key}
              isDisabled={(key) => sourceKeys.has(key)}
              onSelect={selectTarget}
            />
          ))}
        </div>
      </div>

      <div className="block-rules-field">
        <span className="block-rules-field-label">コピーする内容</span>
        <div className="block-rules-mode-segment" role="radiogroup" aria-label="コピーする内容">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "busy"}
            className={
              mode === "busy" ? "block-rules-mode-btn is-selected" : "block-rules-mode-btn"
            }
            onClick={() => setMode("busy")}
          >
            予定あり
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "outOfOffice"}
            className={
              mode === "outOfOffice" ? "block-rules-mode-btn is-selected" : "block-rules-mode-btn"
            }
            onClick={() => setMode("outOfOffice")}
          >
            不在
          </button>
        </div>
        {mode === "outOfOffice" && (
          <p className="block-rules-mode-note">
            不在は Google Workspace
            アカウントのメインカレンダーでのみ利用できます。使えない場合は自動的に「予定あり」になります。
          </p>
        )}
      </div>

      <div className="block-rules-submit-row">
        <button
          type="button"
          className="block-rules-save-btn"
          disabled={!canSave || submitting}
          onClick={handleSave}
        >
          {submitting ? "保存中…" : "ルールを保存"}
        </button>
        {error && <span className="block-rules-error">{error}</span>}
      </div>
    </div>
  );
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

interface CalendarGroupProps {
  group: AccountGroup;
  selectionKind: "checkbox" | "radio";
  isSelected: (key: string) => boolean;
  isDisabled: (key: string) => boolean;
  onSelect: (key: string) => void;
}

/**
 * アカウント見出し + カレンダー一覧(枡チェックボックス/ラジオ)。CalendarSettingsPanel の
 * 「ネイティブ枠を消した button + .masu」実装を踏襲する(checkbox/radio 共通、見た目は同じ
 * 枡オーナメントで表現し、意味の違いは onSelect 側の選択ロジックが持つ)。
 */
function CalendarGroup({
  group,
  selectionKind,
  isSelected,
  isDisabled,
  onSelect,
}: CalendarGroupProps) {
  if (group.options.length === 0) {
    return null;
  }
  return (
    <div className="block-rules-account-group">
      <div className="block-rules-account-header">{group.account.email}</div>
      <ul className="block-rules-cal-list">
        {group.options.map((option) => {
          const selected = isSelected(option.key);
          const disabled = isDisabled(option.key);
          return (
            <li className="block-rules-cal-item" key={option.key}>
              <button
                type="button"
                className="block-rules-cal-checkbox"
                role={selectionKind === "radio" ? "radio" : undefined}
                aria-checked={selectionKind === "radio" ? selected : undefined}
                aria-pressed={selectionKind === "checkbox" ? selected : undefined}
                aria-label={`${option.name}を${selectionKind === "radio" ? "コピー先に" : selected ? "コピー元から外す" : "コピー元に追加"}`}
                disabled={disabled}
                onClick={() => onSelect(option.key)}
              >
                <span
                  className={selected ? "masu masu--kichi" : "masu masu--empty"}
                  style={selected && option.color ? { background: option.color } : undefined}
                />
              </button>
              <span className="block-rules-cal-name">{option.name}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
