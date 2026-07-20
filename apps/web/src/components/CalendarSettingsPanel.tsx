import { useState } from "react";
import type { AccountDTO, CalendarListEntryDTO } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";
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
