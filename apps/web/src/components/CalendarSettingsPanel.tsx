import { useState } from "react";
import type {
  AccountDTO,
  CalendarListEntryDTO,
  McpTokenCreateResponse,
  McpTokenDTO,
} from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";
import { mcpTokenLabel, mcpTokenLastUsedLabel } from "../sync/mcpTokens";
import "./CalendarSettingsPanel.css";

interface CalendarSettingsPanelProps {
  accounts: AccountDTO[];
  /** アカウントごとのカレンダー一覧。未取得・取得失敗のアカウントは未設定 or 空配列のまま(壊れないことを優先) */
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  visibleCalendars: VisibleCalendarsMap;
  onToggleCalendar: (accountId: string, calendarId: string, nextChecked: boolean) => void;
  /** 成功すれば解決、失敗すれば reject する。エラー表示はこのコンポーネント側(行ごとの確認 UI)が持つ */
  onDisconnectAccount: (accountId: string) => Promise<void>;
  onAddAccount: () => void;
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
}

/**
 * ツールバーのアカウント表示部から開くポップオーバー(App.tsx から開閉制御される)。
 * アカウントごとのセクション(email 見出し + カレンダー一覧)+ 最下部の「アカウントを追加」。
 *
 * カレンダーの選択チェックボックスは新規に作らず、既存の枡オーナメント体系
 * (masu.css: 選択=朱の押印 .masu--kichi、未選択=空枡 .masu--empty) をそのまま流用する。
 */
export function CalendarSettingsPanel({
  accounts,
  calendarsByAccount,
  visibleCalendars,
  onToggleCalendar,
  onDisconnectAccount,
  onAddAccount,
  onOpenBlockRules,
  githubLogin,
  githubAuthExpired,
  onConnectGitHub,
  onDisconnectGitHub,
  mcpTokens,
  onCreateMcpToken,
  onDeleteMcpToken,
}: CalendarSettingsPanelProps) {
  return (
    <div className="calendar-panel" role="dialog" aria-label="カレンダー設定">
      {accounts.length === 0 && (
        <p className="calendar-panel-empty">連携中のアカウントがありません</p>
      )}
      {accounts.map((account) => {
        const calendars = calendarsByAccount[account.id] ?? [];
        const visible = visibleCalendars[account.id] ?? [];
        return (
          <div className="calendar-panel-account" key={account.id}>
            <div className="calendar-panel-account-header">{account.email}</div>
            {calendars.length === 0 ? (
              <p className="calendar-panel-empty">
                カレンダーを読み込み中、または取得できませんでした
              </p>
            ) : (
              <ul className="calendar-panel-list">
                {calendars.map((cal) => {
                  const checked = visible.includes(cal.id);
                  return (
                    <li className="calendar-panel-item" key={cal.id}>
                      <button
                        type="button"
                        className="calendar-panel-checkbox"
                        aria-pressed={checked}
                        aria-label={`${cal.summary}を${checked ? "非表示" : "表示"}にする`}
                        onClick={() => onToggleCalendar(account.id, cal.id, !checked)}
                      >
                        {/*
                          brand/README.md「機能色の例外」: カレンダー選択のようにデータ自体が
                          色を持つ文脈では、選択済み枡の塗りをそのデータの色にしてよい
                          (傾き -8° は維持)。色ドットは冗長になるため置かない。
                          背景色は inline style で .masu--kichi の朱を上書きし、
                          backgroundColor が無い場合だけ CSS のフォールバック(朱)に任せる
                        */}
                        <span
                          className={checked ? "masu masu--kichi" : "masu masu--empty"}
                          style={
                            checked && cal.backgroundColor
                              ? { background: cal.backgroundColor }
                              : undefined
                          }
                        />
                      </button>
                      <span className="calendar-panel-cal-name">{cal.summary}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <AccountDisconnectControl accountId={account.id} onDisconnect={onDisconnectAccount} />
          </div>
        );
      })}
      <button type="button" className="calendar-panel-add-account" onClick={onAddAccount}>
        + アカウントを追加
      </button>
      {onOpenBlockRules && (
        <button type="button" className="calendar-panel-add-account" onClick={onOpenBlockRules}>
          予定のブロックを設定
        </button>
      )}
      {/*
       * GitHub 連携 (docs/github-integration.md フェーズ①Part B)。Google アカウントとは
       * 独立した連携なので、アカウント一覧とは別セクションとして「+ アカウントを追加」の下、
       * 凡例フッターの手前に置く。onConnectGitHub が無ければ(呼び出し元が未対応)何も描画しない
       */}
      {onConnectGitHub && (
        <div className="calendar-panel-github">
          <div className="calendar-panel-account-header">GitHub</div>
          {githubLogin ? (
            <div className="calendar-panel-github-connected">
              <span className="calendar-panel-github-login">@{githubLogin}</span>
              {onDisconnectGitHub && <GitHubDisconnectControl onDisconnect={onDisconnectGitHub} />}
            </div>
          ) : (
            <button type="button" className="calendar-panel-add-account" onClick={onConnectGitHub}>
              + GitHub と連携
            </button>
          )}
          {githubAuthExpired && (
            <p className="calendar-panel-github-expired">
              GitHub の認可が切れました。
              <button type="button" className="calendar-panel-text-btn" onClick={onConnectGitHub}>
                再連携
              </button>
            </p>
          )}
        </div>
      )}
      {/*
       * MCP トークン (docs/mcp.md Part A、2026-07-20)。Claude 等の MCP クライアントから
       * kichijitsu を叩くための長期トークンの発行/一覧/失効。GitHub セクションと同じく、
       * mcpTokens が undefined (呼び出し元が未対応) なら何も描画しない
       */}
      {mcpTokens && (
        <McpTokensSection
          tokens={mcpTokens}
          onCreate={onCreateMcpToken}
          onDelete={onDeleteMcpToken}
        />
      )}
      {/*
       * Google 審査要件の導線(プライバシーポリシー・規約)。狭幅ヘッダーではスペース確保のため
       * ヘッダー直下のリンク (.toolbar-legal) を隠す代わりに、設定パネル下部へ集約する
       * (App.tsx 参照)。パネルは幅に余裕があるため常時表示でよい。
       */}
      <div className="calendar-panel-legal">
        <a href="/privacy.html">プライバシー</a>
        <a href="/terms.html">規約</a>
      </div>
    </div>
  );
}

type DisconnectRowState = "idle" | "confirming" | "disconnecting" | "error";

/**
 * アカウント1件ぶんの「連携解除」導線。App.tsx の旧単一アカウント実装と同じ
 * 「window.confirm を使わないインライン2段階確認」を、行ごとに独立した
 * ローカル state として持つ(アカウントが複数あっても他の行に影響しない)。
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
      <span className="calendar-panel-disconnect-confirm">
        連携解除しますか？
        <button
          type="button"
          className="calendar-panel-text-btn"
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
          className="calendar-panel-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="calendar-panel-disconnect-row">
      <button
        type="button"
        className="calendar-panel-text-btn"
        onClick={() => setState("confirming")}
      >
        連携解除
      </button>
      {state === "error" && <span className="calendar-panel-error">解除失敗</span>}
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
      <span className="calendar-panel-disconnect-confirm">
        連携解除しますか？
        <button
          type="button"
          className="calendar-panel-text-btn"
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
          className="calendar-panel-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="calendar-panel-disconnect-row">
      <button
        type="button"
        className="calendar-panel-text-btn"
        onClick={() => setState("confirming")}
      >
        連携解除
      </button>
      {state === "error" && <span className="calendar-panel-error">解除失敗</span>}
    </span>
  );
}

/**
 * MCP トークン (docs/mcp.md Part A、2026-07-20) セクション本体。一覧 + 発行導線を持つ。
 * 「発行直後だけ生値を表示する」状態はこのコンポーネントがローカルに持つ — サーバーは
 * 二度と生値を返さないため、閉じたら (state をクリアしたら) 本当に消える。
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
    <div className="calendar-panel-mcp">
      <div className="calendar-panel-account-header">MCP トークン</div>
      {tokens.length === 0 ? (
        <p className="calendar-panel-empty">発行済みのトークンはありません</p>
      ) : (
        <ul className="calendar-panel-mcp-list">
          {tokens.map((token) => (
            <li className="calendar-panel-mcp-item" key={token.id}>
              <div className="calendar-panel-mcp-item-main">
                <span className="calendar-panel-mcp-item-label">{mcpTokenLabel(token)}</span>
                <span className="calendar-panel-mcp-item-meta">
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
      <span className="calendar-panel-disconnect-confirm">
        失効しますか？
        <button
          type="button"
          className="calendar-panel-text-btn"
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
          className="calendar-panel-text-btn"
          disabled={state === "disconnecting"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="calendar-panel-disconnect-row">
      <button
        type="button"
        className="calendar-panel-text-btn"
        onClick={() => setState("confirming")}
      >
        失効
      </button>
      {state === "error" && <span className="calendar-panel-error">失効失敗</span>}
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
      <div className="calendar-panel-mcp-created">
        <p className="calendar-panel-mcp-warning">
          この値は二度と表示されません。今すぐコピーしてください。
        </p>
        <div className="calendar-panel-mcp-token-row">
          <code className="calendar-panel-mcp-token-value">{result.token}</code>
          <button
            type="button"
            className="calendar-panel-text-btn"
            onClick={() => {
              navigator.clipboard.writeText(result.token).catch((err) => {
                console.error("kichijitsu: clipboard write failed", err);
              });
            }}
          >
            コピー
          </button>
        </div>
        <p className="calendar-panel-mcp-hint">
          Claude 等の MCP クライアント設定で、この値を{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> として{" "}
          <code>https://kichijitsu.love-rox.cc/mcp</code> に登録してください。
        </p>
        <button
          type="button"
          className="calendar-panel-text-btn"
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
      <div className="calendar-panel-mcp-form">
        <input
          type="text"
          className="calendar-panel-mcp-label-input"
          placeholder="ラベル(任意)"
          value={state.kind === "entering-label" ? state.label : ""}
          disabled={disabled}
          onChange={(e) => setState({ kind: "entering-label", label: e.target.value })}
        />
        <button
          type="button"
          className="calendar-panel-text-btn"
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
          className="calendar-panel-text-btn"
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
        className="calendar-panel-add-account"
        onClick={() => setState({ kind: "entering-label", label: "" })}
      >
        + トークンを発行
      </button>
      {state.kind === "error" && <span className="calendar-panel-error">発行失敗</span>}
    </div>
  );
}
