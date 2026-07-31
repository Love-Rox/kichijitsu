/**
 * 設定モーダルの「MCP トークン」セクション (docs/mcp.md Part A) を担当するファイル。
 * 一覧・失効・発行フォームの3つは「発行直後の生トークンを一度だけ見せる」という1つの流れを
 * 共有しているので、分割してもこの3つは同じファイルに置いている。
 */
import { useState } from "react";
import type { McpTokenCreateResponse, McpTokenDTO } from "@kichijitsu/shared";
import { mcpTokenCreatedLabel, mcpTokenLabel, mcpTokenLastUsedLabel } from "../../sync/mcpTokens";
import { ConfirmActionControl } from "./ConfirmActionControl";

/**
 * MCP トークン (docs/mcp.md Part A、2026-07-20) セクション本体。一覧 + 発行導線を持つ。
 * 「発行直後だけ生値を表示する」状態はこのコンポーネントがローカルに持つ — サーバーは
 * 二度と生値を返さないため、閉じたら (state をクリアしたら) 本当に消える。
 * 見出し(「MCP トークン」)は本ファイルの McpTokensSection が持つ。
 */
export function McpTokensSection({
  tokens,
  onCreate,
  onDelete,
}: {
  tokens: McpTokenDTO[];
  onCreate?: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  onDelete?: (id: string) => Promise<void>;
}) {
  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title">MCP トークン</h3>
      <div className="settings-modal-mcp">
        {tokens.length === 0 ? (
          <p className="settings-modal-empty">発行済みのトークンはありません</p>
        ) : (
          <ul className="settings-modal-mcp-list">
            {tokens.map((token) => (
              <li className="settings-modal-mcp-item" key={token.id}>
                <div className="settings-modal-mcp-item-main">
                  <span className="settings-modal-mcp-item-label">{mcpTokenLabel(token)}</span>
                  <span className="settings-modal-mcp-item-meta">
                    発行: {mcpTokenCreatedLabel(token)} / 最終利用: {mcpTokenLastUsedLabel(token)}
                  </span>
                </div>
                {onDelete && <McpTokenDeleteControl tokenId={token.id} onDelete={onDelete} />}
              </li>
            ))}
          </ul>
        )}
        {onCreate && <McpTokenCreateControl onCreate={onCreate} />}
      </div>
    </section>
  );
}

/**
 * トークン1件の「失効」導線。AccountDisconnectControl/GitHubDisconnectControl と
 * 全く同じインライン2段階確認 (ConfirmActionControl) を、対象トークン id だけ差し替えて使う。
 * 成功時は呼び出し元 (App.tsx) が mcpTokens から本行ごと除去する。
 */
function McpTokenDeleteControl({
  tokenId,
  onDelete,
}: {
  tokenId: string;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <ConfirmActionControl
      triggerLabel="失効"
      question="失効しますか？"
      confirmLabel="失効する"
      errorLabel="失効失敗"
      logLabel="MCP token delete"
      onConfirm={() => onDelete(tokenId)}
    />
  );
}

type McpCreateState =
  | { kind: "idle" }
  | { kind: "entering-label"; label: string }
  | { kind: "creating" }
  | { kind: "created"; result: McpTokenCreateResponse }
  | { kind: "error" };

/**
 * トークン発行フォーム。「トークンを発行」ボタン → インラインのラベル入力 → 発行 →
 * 生トークンを一度だけ表示、の流れ。「閉じる」を押すとローカル state (result) を
 * 破棄するだけ — サーバーから生値を取り直す経路は存在しない (二度と表示されない)。
 */
function McpTokenCreateControl({
  onCreate,
}: {
  onCreate: (label: string | undefined) => Promise<McpTokenCreateResponse>;
}) {
  const [state, setState] = useState<McpCreateState>({ kind: "idle" });

  if (state.kind === "created") {
    const { result } = state;
    return (
      <div className="settings-modal-mcp-created">
        <p className="settings-modal-mcp-warning">
          この値は二度と表示されません。今すぐコピーしてください。
        </p>
        <div className="settings-modal-mcp-token-row">
          <code className="settings-modal-mcp-token-value">{result.token}</code>
          <button
            type="button"
            className="settings-modal-text-btn"
            onClick={() => {
              navigator.clipboard.writeText(result.token).catch((err) => {
                console.error("kichijitsu: clipboard write failed", err);
              });
            }}
          >
            コピー
          </button>
        </div>
        {/*
         * MCP エンドポイントは公式ホスト名を焼き込まず、いま開いているインスタンスの
         * origin から組み立てる (2026-07-26)。セルフホストした人の設定画面に
         * 公式インスタンスの URL が出ると、エージェントを他人のサーバーへ繋がせてしまう。
         * デスクトップ版はリモート URL を読み込む方式なので、origin は
         * そのアプリが指しているインスタンスと一致する。
         */}
        <p className="settings-modal-mcp-hint">
          Claude 等の MCP クライアント設定で、この値を{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> として{" "}
          <code>{`${window.location.origin}/mcp`}</code> に登録してください。
        </p>
        <button
          type="button"
          className="settings-modal-text-btn"
          onClick={() => setState({ kind: "idle" })}
        >
          閉じる
        </button>
      </div>
    );
  }

  if (state.kind === "entering-label" || state.kind === "creating") {
    const disabled = state.kind === "creating";
    return (
      <div className="settings-modal-mcp-form">
        <input
          type="text"
          className="settings-modal-mcp-label-input"
          placeholder="ラベル(任意)"
          value={state.kind === "entering-label" ? state.label : ""}
          disabled={disabled}
          onChange={(e) => setState({ kind: "entering-label", label: e.target.value })}
        />
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={disabled}
          onClick={() => {
            const label = state.kind === "entering-label" ? state.label.trim() : "";
            setState({ kind: "creating" });
            onCreate(label.length > 0 ? label : undefined)
              .then((result) => setState({ kind: "created", result }))
              .catch((err) => {
                console.error("kichijitsu: MCP token create failed", err);
                setState({ kind: "error" });
              });
          }}
        >
          発行
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={disabled}
          onClick={() => setState({ kind: "idle" })}
        >
          キャンセル
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="settings-modal-add-account"
        onClick={() => setState({ kind: "entering-label", label: "" })}
      >
        + トークンを発行
      </button>
      {state.kind === "error" && <span className="settings-modal-error">発行失敗</span>}
    </div>
  );
}
