import { useEffect, useRef, useState } from "react";
import type { AccountDTO, McpTokenCreateResponse, McpTokenDTO } from "@kichijitsu/shared";
import { mcpTokenLabel, mcpTokenLastUsedLabel } from "../sync/mcpTokens";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { BUILD_SHA, BUILD_TIME, formatBuildTime, getDesktopVersion } from "../version";
import "./SettingsModal.css";

export interface SettingsModalProps {
  accounts: AccountDTO[];
  /** 成功すれば解決、失敗すれば reject する。エラー表示はこのコンポーネント側(行ごとの確認 UI)が持つ */
  onDisconnectAccount: (accountId: string) => Promise<void>;
  onAddAccount: () => void;
  /**
   * tasks スコープ未付与のアカウント id 集合(docs/google-tasks.md、2026-07-20 追加の
   * .../auth/tasks スコープ)。GET /api/tasklists が 403 を返したアカウントが入る。
   * このセットに含まれる行に「タスクを表示するには再連携が必要です」ヒント + 再連携導線を出す。
   * undefined(呼び出し元が未対応)なら空集合扱いで何も出さない。
   */
  tasksScopeMissingAccounts?: ReadonlySet<string>;
  /**
   * 「再連携」ボタンから呼ぶ(App.tsx 側で /auth/login?add=1 へ遷移する)。同じ Google
   * アカウントを選び直せば prompt=consent で同意画面が再表示され tasks スコープが付く。
   * undefined なら再連携ボタンを出さない(ヒント文だけになる)。
   */
  onReconnectAccount?: () => void;
  /** カレンダーブロック設定オーバーレイ(docs/blocking.md)を開く導線。App.tsx 側で開閉制御する */
  onOpenBlockRules?: () => void;
  /**
   * GitHub 連携状態 (docs/github-integration.md フェーズ①Part B)。undefined/null は未連携
   * (「GitHub と連携」ボタンを出す)、文字列なら連携済みの login 名(「連携解除」導線を出す)
   */
  githubLogin?: string | null;
  /** GET /api/github/items が 401 (github_auth_expired) を返した場合に「再連携」を促す */
  githubAuthExpired?: boolean;
  /** 「GitHub と連携」/「再連携」ボタンから呼ぶ(App.tsx 側で /auth/github/login へ遷移する) */
  onConnectGitHub?: () => void;
  /** 「連携解除」確定で呼ぶ。成功すれば解決、失敗すれば reject する(onDisconnectAccount と同じ流儀) */
  onDisconnectGitHub?: () => Promise<void>;
  /**
   * MCP トークン管理 (docs/mcp.md Part A、2026-07-20)。undefined なら何も描画しない
   * (onConnectGitHub と同じ「呼び出し元が未対応なら黙って隠す」パターン)。
   */
  mcpTokens?: McpTokenDTO[];
  /** 発行ボタンから呼ぶ。成功すれば生トークン込みの行を解決する(表示は本コンポーネントが持つ) */
  onCreateMcpToken?: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  /** 行ごとの「失効」確定で呼ぶ。成功すれば解決、失敗すれば reject する */
  onDeleteMcpToken?: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * 設定モーダル(UI 改善、2026-07-22、ユーザー要望)。ツールバーの「アカウント連携中」ボタンから
 * 開いていたアンカー式ポップオーバー(旧 CalendarSettingsPanel、300px の絶対配置)を、
 * BlockRulesOverlay/TimeReportOverlay と同じ「画面中央固定のモーダルダイアログ」に格上げした。
 * アンカー位置計算(ツールバーのボタン位置に追従させる)が不要になったぶん実装は単純になり、
 * 幅の制約(旧 300px)から解放されて各セクションを見出し付きでゆったり並べられる。
 *
 * 中身は CalendarSettingsPanel の内容をそのまま移植 ―― ロジック・子コンポーネント
 * (AccountDisconnectControl/GitHubDisconnectControl/McpTokensSection 以下)は無変更、
 * 「アカウント」「GitHub」「MCP トークン」「カレンダーブロック」の4セクションに
 * 見出し(BlockRulesOverlay と同じ .settings-modal-section-title)を付けて区切っただけ。
 * カレンダーごとの表示 ON/OFF は引き続きここには無い(カレンダーナビゲーション増分1で
 * CalendarPane.tsx へ移設済み ―― 「選択=左ペイン / 連携管理=設定モーダル」の役割分担は不変)。
 *
 * 開閉: BlockRulesOverlay/TimeReportOverlay と同じ useCloseOnOutsideOrEscape で
 * 外側クリック・Escape に対応する(App.tsx 側の個別リスナーは不要になった)。
 */
export function SettingsModal({
  accounts,
  onDisconnectAccount,
  onAddAccount,
  tasksScopeMissingAccounts,
  onReconnectAccount,
  onOpenBlockRules,
  githubLogin,
  githubAuthExpired,
  onConnectGitHub,
  onDisconnectGitHub,
  mcpTokens,
  onCreateMcpToken,
  onDeleteMcpToken,
  onClose,
}: SettingsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  // デスクトップアプリのバージョン (best-effort、docs/desktop.md 増分2b の gh_api と同じ
  // window.__TAURI__ 経由)。ブラウザ/PWA では常に null のままで、web のビルド情報だけ出す。
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDesktopVersion()
      .then((version) => {
        if (!cancelled) setDesktopVersion(version);
      })
      .catch((err) => {
        // getDesktopVersion 自体は内部で catch して null に丸めるため実際には reject
        // しないが、linter (no-floating-promises) 対策として形だけ持たせる。
        console.error("kichijitsu: getDesktopVersion unexpectedly rejected", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-modal-backdrop">
      <div
        className="settings-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="設定"
      >
        <div className="settings-modal-header">
          <span className="settings-modal-title">設定</span>
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <section className="settings-modal-section">
          <h3 className="settings-modal-section-title">アカウント</h3>
          {accounts.length === 0 && (
            <p className="settings-modal-empty">連携中のアカウントがありません</p>
          )}
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
                      onClick={onReconnectAccount}
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

        {/*
         * GitHub 連携 (docs/github-integration.md フェーズ①Part B)。Google アカウントとは
         * 独立した連携なので独立したセクションにする。onConnectGitHub が無ければ
         * (呼び出し元が未対応)何も描画しない(旧 CalendarSettingsPanel と同じパターン)
         */}
        {onConnectGitHub && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">GitHub</h3>
            {githubLogin ? (
              <div className="settings-modal-github-connected">
                <span className="settings-modal-github-login">@{githubLogin}</span>
                {onDisconnectGitHub && (
                  <GitHubDisconnectControl onDisconnect={onDisconnectGitHub} />
                )}
              </div>
            ) : (
              <button
                type="button"
                className="settings-modal-add-account"
                onClick={onConnectGitHub}
              >
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
          </section>
        )}

        {/*
         * MCP トークン (docs/mcp.md Part A、2026-07-20)。mcpTokens が undefined
         * (呼び出し元が未対応) なら何も描画しない(GitHub セクションと同じパターン)
         */}
        {mcpTokens && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">MCP トークン</h3>
            <McpTokensSection
              tokens={mcpTokens}
              onCreate={onCreateMcpToken}
              onDelete={onDeleteMcpToken}
            />
          </section>
        )}

        {/*
         * カレンダーブロック (docs/blocking.md)。設定モーダルからは既存の BlockRulesOverlay を
         * 開く入口だけを置く(ルール一覧・作成フォームはそちらに任せる ―― 設定モーダルの
         * 幅に収める必要が無くなった今も、二重に持たせず単一の入口を保つ)。
         */}
        {onOpenBlockRules && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">カレンダーブロック</h3>
            <p className="settings-modal-section-desc">
              選んだカレンダーの予定を、別のカレンダーに「予定あり」として自動でコピーします。
            </p>
            <button type="button" className="settings-modal-add-account" onClick={onOpenBlockRules}>
              予定のブロックを設定
            </button>
          </section>
        )}

        {/*
         * Google 審査要件の導線(プライバシーポリシー・規約)。旧 CalendarSettingsPanel と
         * 同じくモーダル下部に集約する。
         */}
        <div className="settings-modal-legal">
          <a href="/privacy.html">プライバシー</a>
          <a href="/terms.html">規約</a>
        </div>

        {/*
         * ビルド番号表示 (ユーザー要望、2026-07-22)。リモート URL 方式のデスクトップアプリで
         * webview がキャッシュ由来の古いビルドを表示し続けても気づけるよう、
         * 「いま見ているビルド」を確認できる控えめな表示をフッターに置く (version.ts 参照)。
         */}
        <p className="settings-build-info">
          {desktopVersion && `アプリ v${desktopVersion} · `}
          ビルド {BUILD_SHA} · {formatBuildTime(BUILD_TIME)}
        </p>
      </div>
    </div>
  );
}

type DisconnectRowState = "idle" | "confirming" | "disconnecting" | "error";

/**
 * アカウント1件ぶんの「連携解除」導線。window.confirm を使わないインライン2段階確認を、
 * 行ごとに独立したローカル state として持つ(アカウントが複数あっても他の行に影響しない)。
 * 旧 CalendarSettingsPanel.tsx の AccountDisconnectControl から無変更で移植。
 */
function AccountDisconnectControl({
  accountId,
  onDisconnect,
}: {
  accountId: string;
  onDisconnect: (accountId: string) => Promise<void>;
}) {
  const [state, setState] = useState<DisconnectRowState>("idle");

  if (state === "confirming" || state === "disconnecting") {
    return (
      <span className="settings-modal-disconnect-confirm">
        連携解除しますか？
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => {
            setState("disconnecting");
            onDisconnect(accountId).catch((err) => {
              console.error("kichijitsu: account disconnect failed", err);
              setState("error");
            });
            // 成功時は呼び出し元 (App.tsx) が accounts から本行ごと除去するので
            // ここでの idle 復帰は不要
          }}
        >
          解除する
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="settings-modal-disconnect-row">
      <button
        type="button"
        className="settings-modal-text-btn"
        onClick={() => setState("confirming")}
      >
        連携解除
      </button>
      {state === "error" && <span className="settings-modal-error">解除失敗</span>}
    </span>
  );
}

/**
 * GitHub 連携の「連携解除」導線。AccountDisconnectControl と全く同じインライン2段階確認だが、
 * こちらは対象を1つに固定できる(GitHub 連携はプロファイルにつき高々1件)ため accountId を取らない。
 */
function GitHubDisconnectControl({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const [state, setState] = useState<DisconnectRowState>("idle");

  if (state === "confirming" || state === "disconnecting") {
    return (
      <span className="settings-modal-disconnect-confirm">
        連携解除しますか？
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => {
            setState("disconnecting");
            onDisconnect().catch((err) => {
              console.error("kichijitsu: GitHub disconnect failed", err);
              setState("error");
            });
            // 成功時は呼び出し元 (App.tsx) が githubLogin を null に戻すので
            // ここでの idle 復帰は不要 (AccountDisconnectControl と同じ流儀)
          }}
        >
          解除する
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="settings-modal-disconnect-row">
      <button
        type="button"
        className="settings-modal-text-btn"
        onClick={() => setState("confirming")}
      >
        連携解除
      </button>
      {state === "error" && <span className="settings-modal-error">解除失敗</span>}
    </span>
  );
}

/**
 * MCP トークン (docs/mcp.md Part A、2026-07-20) セクション本体。一覧 + 発行導線を持つ。
 * 「発行直後だけ生値を表示する」状態はこのコンポーネントがローカルに持つ — サーバーは
 * 二度と生値を返さないため、閉じたら (state をクリアしたら) 本当に消える。
 * 見出し(「MCP トークン」)は呼び出し側 (SettingsModal) の settings-modal-section-title が
 * 担うため、旧 CalendarSettingsPanel と違いここでは自前の見出しを持たない。
 */
function McpTokensSection({
  tokens,
  onCreate,
  onDelete,
}: {
  tokens: McpTokenDTO[];
  onCreate?: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  onDelete?: (id: string) => Promise<void>;
}) {
  return (
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
                  発行: {new Date(token.createdAt).toLocaleString()} / 最終利用:{" "}
                  {mcpTokenLastUsedLabel(token)}
                </span>
              </div>
              {onDelete && <McpTokenDeleteControl tokenId={token.id} onDelete={onDelete} />}
            </li>
          ))}
        </ul>
      )}
      {onCreate && <McpTokenCreateControl onCreate={onCreate} />}
    </div>
  );
}

/**
 * トークン1件の「失効」導線。AccountDisconnectControl/GitHubDisconnectControl と
 * 全く同じインライン2段階確認を、対象トークン id だけ差し替えて使う。
 */
function McpTokenDeleteControl({
  tokenId,
  onDelete,
}: {
  tokenId: string;
  onDelete: (id: string) => Promise<void>;
}) {
  const [state, setState] = useState<DisconnectRowState>("idle");

  if (state === "confirming" || state === "disconnecting") {
    return (
      <span className="settings-modal-disconnect-confirm">
        失効しますか？
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => {
            setState("disconnecting");
            onDelete(tokenId).catch((err) => {
              console.error("kichijitsu: MCP token delete failed", err);
              setState("error");
            });
            // 成功時は呼び出し元 (App.tsx) が mcpTokens から本行ごと除去する
          }}
        >
          失効する
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="settings-modal-disconnect-row">
      <button
        type="button"
        className="settings-modal-text-btn"
        onClick={() => setState("confirming")}
      >
        失効
      </button>
      {state === "error" && <span className="settings-modal-error">失効失敗</span>}
    </span>
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
        <p className="settings-modal-mcp-hint">
          Claude 等の MCP クライアント設定で、この値を{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> として{" "}
          <code>https://kichijitsu.love-rox.cc/mcp</code> に登録してください。
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
