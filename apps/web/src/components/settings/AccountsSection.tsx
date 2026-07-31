/**
 * 設定モーダルの「アカウント」セクション (Google アカウントの一覧・連携解除・追加・再連携) を
 * 担当するファイル。見出しを含むセクション1枚をまるごと持ち、SettingsModal 側は
 * 並び順と props の配線だけを持つ。
 */
import type { AccountDTO } from "@kichijitsu/shared";
import { ConfirmActionControl } from "./ConfirmActionControl";

export function AccountsSection({
  accounts,
  onDisconnectAccount,
  onAddAccount,
  tasksScopeMissingAccounts,
  onReconnectAccount,
}: {
  accounts: AccountDTO[];
  onDisconnectAccount: (accountId: string) => Promise<void>;
  onAddAccount: () => void;
  /** tasks スコープ未付与のアカウント id 集合 (SettingsModalProps の同名 prop 参照) */
  tasksScopeMissingAccounts?: ReadonlySet<string>;
  /** undefined なら再連携ボタンを出さない (ヒント文だけになる) */
  onReconnectAccount?: (email: string) => void;
}) {
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">アカウント</h3>
      {accounts.length === 0 && <p className="settings-modal-empty">連携中のアカウントがありません</p>}
      {accounts.map((account) => (
        <div className="settings-modal-account" key={account.id}>
          <div className="settings-modal-account-header">{account.email}</div>
          <AccountDisconnectControl accountId={account.id} onDisconnect={onDisconnectAccount} />
          {tasksScopeMissingAccounts?.has(account.id) && (
            <p className="settings-modal-tasks-scope-missing">
              タスクを表示するには再連携が必要です。
              {onReconnectAccount && (
                <button
                  type="button"
                  className="settings-modal-text-btn"
                  onClick={() => onReconnectAccount(account.email)}
                >
                  再連携
                </button>
              )}
            </p>
          )}
        </div>
      ))}
      <button type="button" className="settings-modal-add-account" onClick={onAddAccount}>
        + アカウントを追加
      </button>
    </section>
  );
}

/**
 * アカウント1件ぶんの「連携解除」導線。インライン2段階確認 (ConfirmActionControl) を、
 * 行ごとに独立したローカル state として持つ(アカウントが複数あっても他の行に影響しない)。
 * 成功時に idle へ戻さないのは、呼び出し元 (App.tsx) が accounts から本行ごと除去するため。
 */
function AccountDisconnectControl({
  accountId,
  onDisconnect,
}: {
  accountId: string;
  onDisconnect: (accountId: string) => Promise<void>;
}) {
  return (
    <ConfirmActionControl
      triggerLabel="連携解除"
      question="連携解除しますか？"
      confirmLabel="解除する"
      errorLabel="解除失敗"
      logLabel="account disconnect"
      onConfirm={() => onDisconnect(accountId)}
    />
  );
}
