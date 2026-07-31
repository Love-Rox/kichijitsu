import { useRef } from "react";
import type { AccountDTO, McpTokenCreateResponse, McpTokenDTO } from "@kichijitsu/shared";
import { isTauri } from "../sync/githubProvider";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { AccountsSection } from "./settings/AccountsSection";
import { BlockRulesSection } from "./settings/BlockRulesSection";
import { BuildInfoFooter } from "./settings/BuildInfoFooter";
import { CacheClearControl } from "./settings/CacheClearControl";
import { GitHubSection } from "./settings/GitHubSection";
import { McpTokensSection } from "./settings/McpTokensSection";
import { ReminderSection } from "./settings/ReminderSection";
import { ResyncControl } from "./settings/ResyncControl";
import { ThemeSection } from "./settings/ThemeSection";
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
   * undefined なら再連携ボタンを出さない(ヒント文だけになる)。対象アカウントのメールを
   * 渡すので、App.tsx 側で login_hint に載せて Google 側にそのアカウントを事前選択させる。
   */
  onReconnectAccount?: (email: string) => void;
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
  /**
   * 「再同期」(全件取り直し、2026-07-29) の確定で呼ぶ。全同期が終わるまで解決せず、
   * 1つでも失敗すれば reject する(hooks/useCalendarSync.ts の runFullResync)。
   * undefined なら再同期の導線を出さない(他の任意セクションと同じ流儀)
   */
  onResync?: () => Promise<void>;
  onClose: () => void;
}

/**
 * 設定モーダル(UI 改善、2026-07-22、ユーザー要望)。ツールバーの「アカウント連携中」ボタンから
 * 開いていたアンカー式ポップオーバー(旧 CalendarSettingsPanel、300px の絶対配置)を、
 * BlockRulesOverlay/TimeReportOverlay と同じ「画面中央固定のモーダルダイアログ」に格上げした。
 * アンカー位置計算(ツールバーのボタン位置に追従させる)が不要になったぶん実装は単純になり、
 * 幅の制約(旧 300px)から解放されて各セクションを見出し付きでゆったり並べられる。
 *
 * カレンダーごとの表示 ON/OFF は引き続きここには無い(カレンダーナビゲーション増分1で
 * CalendarPane.tsx へ移設済み ―― 「選択=左ペイン / 連携管理=設定モーダル」の役割分担は不変)。
 *
 * 開閉: BlockRulesOverlay/TimeReportOverlay と同じ useCloseOnOutsideOrEscape で
 * 外側クリック・Escape に対応する(App.tsx 側の個別リスナーは不要になった)。
 *
 * ## このファイルの守備範囲 (セクション分割、2026-07-31)
 * 独立した設定項目が11個まで増えて1ファイル 955 行になっていたので、セクション単位で
 * ./settings/ 配下へ切り出した。**このファイルに残すのは「枠 (backdrop/card/ヘッダー) と
 * 並び順、そして各セクションを出すかどうかの判断」だけ**で、セクションの中身 (state・
 * 説明文・入力欄) は一切持たない ―― 上から読めば設定モーダルの目次になるようにしてある。
 * 「出すかどうか」をここに集めているのは、`onConnectGitHub && ...` のような
 * 「呼び出し元が未対応なら黙って隠す」判断が全セクションに共通する規則だから
 * (各セクションに散らすと、規則が守られているかを1画面で確認できなくなる)。
 *
 * CSS は分割していない (SettingsModal.css のまま)。クラス名が1つも変わらないうえ、
 * ここでの import 1回で全セクションぶんが読み込まれる。
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
  onResync,
  onClose,
}: SettingsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

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

        <AccountsSection
          accounts={accounts}
          onDisconnectAccount={onDisconnectAccount}
          onAddAccount={onAddAccount}
          tasksScopeMissingAccounts={tasksScopeMissingAccounts}
          onReconnectAccount={onReconnectAccount}
        />

        {/*
         * GitHub 連携 (docs/github-integration.md フェーズ①Part B)。Google アカウントとは
         * 独立した連携なので独立したセクションにする。onConnectGitHub が無ければ
         * (呼び出し元が未対応)何も描画しない(旧 CalendarSettingsPanel と同じパターン)
         */}
        {onConnectGitHub && (
          <GitHubSection
            githubLogin={githubLogin}
            githubAuthExpired={githubAuthExpired}
            onConnectGitHub={onConnectGitHub}
            onDisconnectGitHub={onDisconnectGitHub}
          />
        )}

        {/*
         * MCP トークン (docs/mcp.md Part A、2026-07-20)。mcpTokens が undefined
         * (呼び出し元が未対応) なら何も描画しない(GitHub セクションと同じパターン)
         */}
        {mcpTokens && (
          <McpTokensSection
            tokens={mcpTokens}
            onCreate={onCreateMcpToken}
            onDelete={onDeleteMcpToken}
          />
        )}

        {/*
         * カレンダーブロック (docs/blocking.md)。設定モーダルからは既存の BlockRulesOverlay を
         * 開く入口だけを置く(ルール一覧・作成フォームはそちらに任せる ―― 設定モーダルの
         * 幅に収める必要が無くなった今も、二重に持たせず単一の入口を保つ)。
         */}
        {onOpenBlockRules && <BlockRulesSection onOpenBlockRules={onOpenBlockRules} />}

        {/*
         * 予定のリマインダー通知 (2026-07-30)。デスクトップ版 (Tauri) だけの機能なので
         * ブラウザ/PWA には出さない ―― そちらには通知の配線そのものが無い
         * (apps/web/src/sync/desktopNotify.ts 冒頭参照)。テーマと同じく localStorage だけで
         * 完結するため props に依存しない。
         */}
        {isTauri() && <ReminderSection />}

        {/*
         * テーマ (ダークモード切替、ユーザー要望、2026-07-26)。連携系のセクションとは
         * 性質が違う「見た目の設定」なので最後に置く。呼び出し元の props に依存しない
         * (localStorage だけで完結する) ため、他セクションと違い常に描画される。
         */}
        <ThemeSection />

        {/*
         * Google 審査要件の導線(プライバシーポリシー・規約)。旧 CalendarSettingsPanel と
         * 同じくモーダル下部に集約する。
         */}
        <div className="settings-modal-legal">
          <a href="/privacy.html">プライバシー</a>
          <a href="/terms.html">規約</a>
        </div>

        {/* ビルド情報 + デスクトップ版向けの再読み込み案内 (settings/BuildInfoFooter.tsx) */}
        <BuildInfoFooter />

        {/*
         * キャッシュ削除 (ユーザー要望、2026-07-26)。上のビルド情報で「古いビルドを
         * 見ている」と気づいた人がその場で直せるよう、すぐ下に脱出口を置く。
         */}
        <CacheClearControl />

        {/*
         * 再同期 (ユーザー要望、2026-07-29)。キャッシュ削除と並ぶ「困ったときの脱出口」で、
         * 住み分けは 表示が古い → キャッシュ削除 (表示用ファイルの入れ替え) /
         * 予定の中身がおかしい → 再同期 (予定データの取り直し)。並べて置くことで
         * 説明文どうしを読み比べて選べるようにしている。
         */}
        {onResync && <ResyncControl onResync={onResync} />}
      </div>
    </div>
  );
}
