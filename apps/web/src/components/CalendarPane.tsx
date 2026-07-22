import { useRef, useState } from "react";
import type { AccountDTO, CalendarListEntryDTO } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";
import { groupCalendarsByAccess } from "../sync/calendarGroups";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import type { PaneMode } from "../layout/paneMode";
import "./CalendarPane.css";

export interface CalendarPaneProps {
  mode: PaneMode;
  onModeChange: (mode: PaneMode) => void;
  onClose: () => void;
  /** 狭幅(isNarrow)のとき true — モード切替ボタン自体を出さない(常に overlay 固定のため、GitHubPane と同じ流儀) */
  disableModeToggle: boolean;
  accounts: AccountDTO[];
  /** アカウントごとのカレンダー一覧。未取得・取得失敗のアカウントは未設定 or 空配列のまま(壊れないことを優先、CalendarSettingsPanel から引き継いだ挙動) */
  calendarsByAccount: Record<string, CalendarListEntryDTO[]>;
  visibleCalendars: VisibleCalendarsMap;
  /**
   * App.tsx の handleToggleCalendar をそのまま渡す想定 ―― watch 登録・PUT・即時同期・
   * 解除時のローカルデータ削除のロジックはこのコンポーネントからは一切触らない
   * (カレンダーナビゲーション増分1: 「選択=左ペイン / 連携管理=設定パネル」の役割分担のうち、
   * このコンポーネントは「選択」の見た目だけを担当する)。
   */
  onToggleCalendar: (accountId: string, calendarId: string, nextChecked: boolean) => void;
}

const COLLAPSED_ACCOUNTS_STORAGE_KEY = "kichijitsu:calendarPaneCollapsedAccounts";

/** localStorage に保存された折りたたみ済みアカウント id 集合を読む。プライベートモード等で無効なら空集合 */
function loadCollapsedAccounts(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_ACCOUNTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsedAccounts(collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_ACCOUNTS_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* ignore */
  }
}

/**
 * 左ペイン「カレンダー」(カレンダーナビゲーション増分1、2026-07-22)。Notion Calendar に倣い、
 * これまで設定パネル(CalendarSettingsPanel)内に埋もれていたカレンダーの表示 ON/OFF 選択を
 * 独立した常設ペインへ切り出す。役割分担は「選択=左ペイン / 連携管理=設定パネル」
 * (ユーザー決定) ―― アカウント追加/解除・GitHub 連携・MCP トークン等は引き続き設定パネル側。
 *
 * GitHubPane(右ペイン)と対称の docked/overlay 機構(layout/paneMode.ts、
 * shouldCloseOtherPaneOnOpen で相互の overlay 排他を App.tsx 側が処理する)をそのまま再利用する:
 *   - overlay: fixed backdrop + 左からスライドインする常設サイドレール。外側クリック・Escape で閉じる。
 *   - docked: グリッドの左に常設する flex サイドバー。外側クリック・Escape では閉じない。
 *
 * アカウントごとにセクション化し(email 見出し、折りたたみ可・状態は localStorage 永続)、
 * 各セクション内をさらに accessRole で「マイカレンダー」(owner)と「他のカレンダー」
 * (writer/reader/freeBusyReader/未設定 ―― 祝日・購読・同僚のカレンダー等)に分ける
 * (groupCalendarsByAccess、sync/calendarGroups.ts の純関数)。各行は既存の枡チェック
 * (カレンダー色)+カレンダー名で、トグルは onToggleCalendar(App.tsx の handleToggleCalendar)を
 * そのまま呼ぶだけ ―― データ変更ロジックはこのコンポーネントには一切無い。
 */
export function CalendarPane({
  mode,
  onModeChange,
  onClose,
  disableModeToggle,
  accounts,
  calendarsByAccount,
  visibleCalendars,
  onToggleCalendar,
}: CalendarPaneProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isOverlay = mode === "overlay";
  // docked(常設)は外側クリック・Escape では閉じない — active=false でリスナー自体を張らない(GitHubPane と同じ)
  useCloseOnOutsideOrEscape(isOverlay, cardRef, onClose);

  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<string>>(() =>
    loadCollapsedAccounts(),
  );

  function toggleAccountCollapsed(accountId: string) {
    setCollapsedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      saveCollapsedAccounts(next);
      return next;
    });
  }

  const paneRoot = (
    <div
      className={
        isOverlay ? "calendar-pane calendar-pane--overlay" : "calendar-pane calendar-pane--docked"
      }
      ref={cardRef}
      role={isOverlay ? "dialog" : undefined}
      aria-label="カレンダー"
    >
      <div className="calendar-pane-header">
        <span className="calendar-pane-title">カレンダー</span>
        <div className="calendar-pane-actions">
          {!disableModeToggle && (
            <button
              type="button"
              className="calendar-pane-mode-btn"
              onClick={() => onModeChange(isOverlay ? "docked" : "overlay")}
              aria-label={isOverlay ? "常設ドッキングに切り替え" : "オーバーレイに切り替え"}
              title={isOverlay ? "常設ドッキングに切り替え" : "オーバーレイに切り替え"}
            >
              <span aria-hidden="true">{isOverlay ? "📌" : "⧉"}</span>
            </button>
          )}
          <button
            type="button"
            className="calendar-pane-close-btn"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      </div>

      <div className="calendar-pane-body">
        {accounts.length === 0 && (
          <p className="calendar-pane-empty-all">連携中のアカウントがありません</p>
        )}
        {accounts.map((account) => (
          <AccountSection
            key={account.id}
            account={account}
            calendars={calendarsByAccount[account.id] ?? []}
            visible={visibleCalendars[account.id] ?? []}
            collapsed={collapsedAccounts.has(account.id)}
            onToggleCollapsed={() => toggleAccountCollapsed(account.id)}
            onToggleCalendar={onToggleCalendar}
          />
        ))}
      </div>
    </div>
  );

  if (isOverlay) {
    return <div className="calendar-pane-backdrop">{paneRoot}</div>;
  }
  return paneRoot;
}

interface AccountSectionProps {
  account: AccountDTO;
  calendars: CalendarListEntryDTO[];
  visible: string[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleCalendar: (accountId: string, calendarId: string, nextChecked: boolean) => void;
}

/**
 * アカウント1件ぶんのセクション。見出し(email)をクリックすると折りたたみ/展開する
 * (▸/▾ の向きで状態を示す)。折りたたみ中はカレンダー一覧そのものを描画しない
 * (件数が多いアカウントでのスクロール量を減らす)。
 */
function AccountSection({
  account,
  calendars,
  visible,
  collapsed,
  onToggleCollapsed,
  onToggleCalendar,
}: AccountSectionProps) {
  const { mine, others } = groupCalendarsByAccess(calendars);

  return (
    <div className="calendar-pane-account">
      <button
        type="button"
        className="calendar-pane-account-header"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
      >
        <span className="calendar-pane-account-caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="calendar-pane-account-email">{account.email}</span>
      </button>
      {!collapsed &&
        (calendars.length === 0 ? (
          <p className="calendar-pane-empty">カレンダーを読み込み中、または取得できませんでした</p>
        ) : (
          <>
            <CalendarGroup
              label="マイカレンダー"
              calendars={mine}
              accountId={account.id}
              visible={visible}
              onToggleCalendar={onToggleCalendar}
            />
            <CalendarGroup
              label="他のカレンダー"
              calendars={others}
              accountId={account.id}
              visible={visible}
              onToggleCalendar={onToggleCalendar}
            />
          </>
        ))}
    </div>
  );
}

interface CalendarGroupProps {
  label: string;
  calendars: CalendarListEntryDTO[];
  accountId: string;
  visible: string[];
  onToggleCalendar: (accountId: string, calendarId: string, nextChecked: boolean) => void;
}

/** マイカレンダー/他のカレンダーの片方のグループ。空グループは見出しごと出さない(空の「他のカレンダー」等でノイズを増やさない) */
function CalendarGroup({
  label,
  calendars,
  accountId,
  visible,
  onToggleCalendar,
}: CalendarGroupProps) {
  if (calendars.length === 0) return null;

  return (
    <div className="calendar-pane-group">
      <h4 className="calendar-pane-group-title">{label}</h4>
      <ul className="calendar-pane-list">
        {calendars.map((cal) => {
          const checked = visible.includes(cal.id);
          return (
            <li className="calendar-pane-item" key={cal.id}>
              <button
                type="button"
                className="calendar-pane-checkbox"
                aria-pressed={checked}
                aria-label={`${cal.summary}を${checked ? "非表示" : "表示"}にする`}
                onClick={() => onToggleCalendar(accountId, cal.id, !checked)}
              >
                {/*
                  brand/README.md「機能色の例外」: カレンダー選択のようにデータ自体が色を持つ
                  文脈では、選択済み枡の塗りをそのデータの色にしてよい(傾き -8° は維持)。
                  CalendarSettingsPanel の旧チェックボックス実装をそのまま踏襲。
                */}
                <span
                  className={checked ? "masu masu--kichi" : "masu masu--empty"}
                  style={
                    checked && cal.backgroundColor ? { background: cal.backgroundColor } : undefined
                  }
                />
              </button>
              <span className="calendar-pane-cal-name">{cal.summary}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
