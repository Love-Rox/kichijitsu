/**
 * 設定モーダルの「GitHub」セクション (連携状態の表示・連携/再連携・解除、および
 * デスクトップ限定の gh パス手動指定) を担当するファイル。
 * セクションごと描画するかどうか (呼び出し元が GitHub 連携に未対応なら丸ごと隠す) の判断は
 * SettingsModal 側が持つ ―― ここは「出すと決まったときに何を出すか」だけを持つ。
 */
import { isTauri } from "../../sync/githubProvider";
import { ConfirmActionControl } from "./ConfirmActionControl";
import { GhPathOverrideControl } from "./GhPathOverrideControl";

export function GitHubSection({
  githubLogin,
  githubAuthExpired,
  onConnectGitHub,
  onDisconnectGitHub,
}: {
  /** undefined/null は未連携、文字列なら連携済みの login 名 */
  githubLogin?: string | null;
  /** GET /api/github/items が 401 (github_auth_expired) を返した場合に「再連携」を促す */
  githubAuthExpired?: boolean;
  onConnectGitHub: () => void;
  /** undefined なら連携解除の導線を出さない */
  onDisconnectGitHub?: () => Promise<void>;
}) {
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">GitHub</h3>
      {githubLogin ? (
        <div className="settings-modal-github-connected">
          <span className="settings-modal-github-login">@{githubLogin}</span>
          {onDisconnectGitHub && <GitHubDisconnectControl onDisconnect={onDisconnectGitHub} />}
        </div>
      ) : (
        <button type="button" className="settings-modal-add-account" onClick={onConnectGitHub}>
          + GitHub と連携
        </button>
      )}
      {githubAuthExpired && (
        <p className="settings-modal-github-expired">
          GitHub の認可が切れました。
          <button type="button" className="settings-modal-text-btn" onClick={onConnectGitHub}>
            再連携
          </button>
        </p>
      )}
      {/* デスクトップ(Tauri)のみ: gh のパスを手動指定できる。GUI 起動で PATH に gh が無く、
          自動検出(resolve_gh_path)でも拾えない非標準の場所に置いている人向け。 */}
      {isTauri() && <GhPathOverrideControl />}
    </section>
  );
}

/**
 * GitHub 連携の「連携解除」導線。AccountDisconnectControl と全く同じインライン2段階確認だが、
 * こちらは対象を1つに固定できる(GitHub 連携はプロファイルにつき高々1件)ため accountId を取らない。
 */
function GitHubDisconnectControl({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  return (
    <ConfirmActionControl
      triggerLabel="連携解除"
      question="連携解除しますか？"
      confirmLabel="解除する"
      errorLabel="解除失敗"
      logLabel="GitHub disconnect"
      onConfirm={onDisconnect}
    />
  );
}
