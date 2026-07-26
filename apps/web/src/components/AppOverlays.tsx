import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { BlockRulesOverlay } from "./BlockRulesOverlay";
import { KeyboardHelpOverlay } from "./KeyboardHelpOverlay";
import { SearchOverlay } from "./SearchOverlay";
import { SettingsModal } from "./SettingsModal";
import { TimeReportOverlay } from "./TimeReportOverlay";
import type { GoogleAccountsController } from "../hooks/useGoogleAccounts";

/**
 * App 直下に並ぶオーバーレイ群 ―― ヘルプ / 設定モーダル / カレンダーブロック設定 /
 * 予定検索 / 予定 vs 実績レポート(リファクタリング フェーズ3b、2026-07-26 に App.tsx から切り出し)。
 *
 * AppToolbar と同じ理由・同じ方針での切り出し: 表示だけの塊なので JSX を1文字も変えずに移し、
 * 開閉フラグと各オーバーレイへ渡す値・ハンドラを props でそのまま受け取る。返すのは
 * フラグメントなので DOM 構造も分割前と完全に同一(App.tsx の `<div className="app">` の
 * 直接の子として同じ順に並ぶ)。
 *
 * props の型は各オーバーレイ自身の props から ComponentProps<typeof X>[...] で引いている ――
 * ここで型を書き起こすと、将来オーバーレイ側のシグネチャが変わったときに中継地点だけが
 * 古いまま通ってしまうため。
 */
export interface AppOverlaysProps {
  me: GoogleAccountsController["me"];
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  handleDisconnectAccount: ComponentProps<typeof SettingsModal>["onDisconnectAccount"];
  tasksScopeMissingAccounts: ComponentProps<typeof SettingsModal>["tasksScopeMissingAccounts"];
  setBlockOverlayOpen: Dispatch<SetStateAction<boolean>>;
  githubAuthExpired: ComponentProps<typeof SettingsModal>["githubAuthExpired"];
  handleDisconnectGitHub: ComponentProps<typeof SettingsModal>["onDisconnectGitHub"];
  mcpTokens: ComponentProps<typeof SettingsModal>["mcpTokens"];
  handleCreateMcpToken: ComponentProps<typeof SettingsModal>["onCreateMcpToken"];
  handleDeleteMcpToken: ComponentProps<typeof SettingsModal>["onDeleteMcpToken"];
  blockOverlayOpen: boolean;
  calendarsByAccount: GoogleAccountsController["calendarsByAccount"];
  blockRules: ComponentProps<typeof BlockRulesOverlay>["rules"];
  handleCreateBlockRule: ComponentProps<typeof BlockRulesOverlay>["onCreate"];
  handleDeleteBlockRule: ComponentProps<typeof BlockRulesOverlay>["onDelete"];
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  db: ComponentProps<typeof SearchOverlay>["db"];
  timeZone: string;
  visibleCalendarKeys: ComponentProps<typeof SearchOverlay>["visibleCalendarKeys"];
  calendarLookup: ComponentProps<typeof SearchOverlay>["calendarLookup"];
  handleSearchJump: ComponentProps<typeof SearchOverlay>["onJump"];
  reportOpen: boolean;
  setReportOpen: Dispatch<SetStateAction<boolean>>;
  reportPlannedBlocks: ComponentProps<typeof TimeReportOverlay>["plannedBlocks"];
  reportTimeEntries: ComponentProps<typeof TimeReportOverlay>["timeEntries"];
  reportWorkLogs: ComponentProps<typeof TimeReportOverlay>["workLogs"];
  timerNowMs: ComponentProps<typeof TimeReportOverlay>["nowMs"];
  prCommitEstimates: ComponentProps<typeof TimeReportOverlay>["estimatedByKey"];
  prCommitEstimatesLoading: ComponentProps<typeof TimeReportOverlay>["estimatesLoading"];
  reportHookActualByLinkedItem: ComponentProps<typeof TimeReportOverlay>["hookActualByLinkedItem"];
}

export function AppOverlays({
  me,
  helpOpen,
  setHelpOpen,
  panelOpen,
  setPanelOpen,
  handleDisconnectAccount,
  tasksScopeMissingAccounts,
  setBlockOverlayOpen,
  githubAuthExpired,
  handleDisconnectGitHub,
  mcpTokens,
  handleCreateMcpToken,
  handleDeleteMcpToken,
  blockOverlayOpen,
  calendarsByAccount,
  blockRules,
  handleCreateBlockRule,
  handleDeleteBlockRule,
  searchOpen,
  setSearchOpen,
  db,
  timeZone,
  visibleCalendarKeys,
  calendarLookup,
  handleSearchJump,
  reportOpen,
  setReportOpen,
  reportPlannedBlocks,
  reportTimeEntries,
  reportWorkLogs,
  timerNowMs,
  prCommitEstimates,
  prCommitEstimatesLoading,
  reportHookActualByLinkedItem,
}: AppOverlaysProps) {
  return (
    <>
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}
      {/*
       * 設定モーダル(UI 改善、2026-07-22、ユーザー要望「中央配置の設定モーダルへ格上げ」)。
       * 旧 CalendarSettingsPanel はツールバーの .toolbar-account 内にアンカー式ポップオーバーと
       * して描画していたが、中央固定モーダルになったことでアンカー位置計算が不要になり、
       * BlockRulesOverlay/SearchOverlay/TimeReportOverlay と同じくオーバーレイ群として
       * ここ(App 直下)へ移した。開閉制御(panelOpen)自体は変更していない。
       */}
      {panelOpen && me.accounts.length > 0 && (
        <SettingsModal
          accounts={me.accounts}
          onDisconnectAccount={handleDisconnectAccount}
          onAddAccount={() => {
            window.location.href = "/auth/login?add=1";
          }}
          tasksScopeMissingAccounts={tasksScopeMissingAccounts}
          onReconnectAccount={(email) => {
            // 同じ Google アカウントを選び直せば prompt=consent (apps/sync の oauth.ts) で
            // 同意画面が再表示され、2026-07-20 追加の tasks スコープが付与される。
            // 遷移先は「+ アカウントを追加」と同じ /auth/login?add=1 だが、login_hint に
            // 対象アカウントのメールを載せて Google 側でそのアカウントを事前選択させる。
            window.location.href = `/auth/login?add=1&login_hint=${encodeURIComponent(email)}`;
          }}
          onOpenBlockRules={() => {
            setPanelOpen(false);
            setBlockOverlayOpen(true);
          }}
          githubLogin={me.github?.login ?? null}
          githubAuthExpired={githubAuthExpired}
          onConnectGitHub={() => {
            window.location.href = "/auth/github/login";
          }}
          onDisconnectGitHub={handleDisconnectGitHub}
          mcpTokens={mcpTokens}
          onCreateMcpToken={handleCreateMcpToken}
          onDeleteMcpToken={handleDeleteMcpToken}
          onClose={() => setPanelOpen(false)}
        />
      )}
      {blockOverlayOpen && me.connected && (
        <BlockRulesOverlay
          accounts={me.accounts}
          calendarsByAccount={calendarsByAccount}
          rules={blockRules}
          onCreate={handleCreateBlockRule}
          onDelete={handleDeleteBlockRule}
          onClose={() => setBlockOverlayOpen(false)}
        />
      )}
      {searchOpen && (
        <SearchOverlay
          onClose={() => setSearchOpen(false)}
          db={db}
          timeZone={timeZone}
          visibleCalendarKeys={visibleCalendarKeys}
          calendarLookup={calendarLookup}
          onJump={handleSearchJump}
        />
      )}
      {reportOpen && (
        <TimeReportOverlay
          plannedBlocks={reportPlannedBlocks}
          timeEntries={reportTimeEntries}
          workLogs={reportWorkLogs}
          nowMs={timerNowMs}
          estimatedByKey={me.github ? prCommitEstimates : {}}
          estimatesLoading={prCommitEstimatesLoading}
          hookActualByLinkedItem={reportHookActualByLinkedItem}
          onClose={() => setReportOpen(false)}
        />
      )}
    </>
  );
}
