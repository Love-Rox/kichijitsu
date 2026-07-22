import { useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { AccountDTO, CalendarListEntryDTO, TaskListDTO } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";
import { groupCalendarsByAccess } from "../sync/calendarGroups";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import type { PaneMode } from "../layout/paneMode";
import type { View } from "../keyboard/shortcuts";
import { MiniMonthCalendar } from "./MiniMonthCalendar";
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

  // ---- ミニ月カレンダー(左ペイン増分2、2026-07-22) ----
  /** 現在の表示形式。ミニカレンダーが「メインの表示中の範囲」を淡くハイライトするのに使う */
  view: View;
  timelineStart: Temporal.PlainDate;
  dayCount: number;
  monthCursor: Temporal.PlainDate;
  timeZone: string;
  /** ミニカレンダーで日付をクリックしたときに呼ばれる(App.tsx が resolveMiniMonthNavigation 経由で反映する) */
  onNavigateDate: (date: Temporal.PlainDate) => void;

  // ---- タスクリスト選択(左ペイン増分2) ----
  /** アカウントごとのタスクリスト一覧。App.tsx の taskListsByAccount をそのまま渡す */
  taskListsByAccount: Record<string, TaskListDTO[]>;
  /**
   * 明示的に非表示にした `${accountId}:${taskListId}` の集合(デフォルト全 ON、
   * db/database.ts の getHiddenTaskLists と同じ形。App.tsx がローカルのみで永続化する)。
   */
  hiddenTaskListKeys: Set<string>;
  onToggleTaskList: (accountId: string, taskListId: string, nextChecked: boolean) => void;

  // ---- GitHub セクション(左ペイン増分2、ペイン最下部) ----
  /** 連携済みなら login 名、未連携なら null(操作はここに置かない ―― 連携管理は設定パネルの役割) */
  githubLogin: string | null;
  /** ツールバーから移設した表示トグル(実績オーバーレイ・CI/Actions 実行、下の GitHubSection 参照) */
  activityVisible: boolean;
  onToggleActivityVisible: () => void;
  ciVisible: boolean;
  onToggleCiVisible: () => void;
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
 *
 * 左ペイン増分2(2026-07-22)でペイン内を3セクション構成に拡張した(body 上から):
 *   1. ミニ月カレンダー(MiniMonthCalendar) ―― タイムラインナビゲーション
 *   2. カレンダー選択(上記、増分1からの既存部分)
 *   3. アカウントごとのタスクリスト選択(TaskListGroup、AccountSection 内)
 *   4. GitHub セクション(GitHubSection、ペイン最下部) ―― 接続状態表示 + 表示トグル移設
 * ペイン全体は calendar-pane-body の overflow-y: auto で縦スクロールする(CalendarPane.css)ため、
 * 3セクション+既存カレンダー選択がどれだけ増えても狭幅 overlay 内に収まる。
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
  view,
  timelineStart,
  dayCount,
  monthCursor,
  timeZone,
  onNavigateDate,
  taskListsByAccount,
  hiddenTaskListKeys,
  onToggleTaskList,
  githubLogin,
  activityVisible,
  onToggleActivityVisible,
  ciVisible,
  onToggleCiVisible,
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
        <MiniMonthCalendar
          view={view}
          timelineStart={timelineStart}
          dayCount={dayCount}
          monthCursor={monthCursor}
          timeZone={timeZone}
          onNavigateDate={onNavigateDate}
        />

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
            taskLists={taskListsByAccount[account.id] ?? []}
            hiddenTaskListKeys={hiddenTaskListKeys}
            onToggleTaskList={onToggleTaskList}
          />
        ))}

        <GitHubSection
          githubLogin={githubLogin}
          activityVisible={activityVisible}
          onToggleActivityVisible={onToggleActivityVisible}
          ciVisible={ciVisible}
          onToggleCiVisible={onToggleCiVisible}
        />
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
  // ---- タスクリスト選択(左ペイン増分2) ----
  taskLists: TaskListDTO[];
  hiddenTaskListKeys: Set<string>;
  onToggleTaskList: (accountId: string, taskListId: string, nextChecked: boolean) => void;
}

/**
 * アカウント1件ぶんのセクション。見出し(email)をクリックすると折りたたみ/展開する
 * (▸/▾ の向きで状態を示す)。折りたたみ中はカレンダー一覧そのものを描画しない
 * (件数が多いアカウントでのスクロール量を減らす)。
 *
 * 左ペイン増分2で「他のカレンダー」の下にタスクリストグループを追加した(要件どおり
 * アカウントセクション内 ―― タスクリストもアカウント単位の概念のため)。折りたたみの
 * 対象にもカレンダーと同じくタスクリストを含める(collapsed 中は一切描画しない)。
 */
function AccountSection({
  account,
  calendars,
  visible,
  collapsed,
  onToggleCollapsed,
  onToggleCalendar,
  taskLists,
  hiddenTaskListKeys,
  onToggleTaskList,
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
      {!collapsed && (
        <TaskListGroup
          accountId={account.id}
          taskLists={taskLists}
          hiddenTaskListKeys={hiddenTaskListKeys}
          onToggleTaskList={onToggleTaskList}
        />
      )}
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

interface TaskListGroupProps {
  accountId: string;
  taskLists: TaskListDTO[];
  hiddenTaskListKeys: Set<string>;
  onToggleTaskList: (accountId: string, taskListId: string, nextChecked: boolean) => void;
}

/**
 * タスクリスト表示 ON/OFF(左ペイン増分2、2026-07-22、docs/google-tasks.md の TODO 解消)。
 * CalendarGroup と見た目・操作感を揃えるが、タスクリストにはカレンダーのような
 * backgroundColor が無いため、選択済みでも brand/README.md の「機能色の例外」は適用せず
 * 常に薄墨(masu--kichi の既定色)の枡のままにする ―― カレンダー選択の CalendarGroup と
 * 唯一違う点。tasks スコープ未許可 / 未取得のアカウントは taskLists が空になるため、
 * CalendarGroup と同じく見出しごと出さない(空の「他のカレンダー」を出さないのと同じ流儀)。
 *
 * チェック済み(表示 ON)の判定は「hiddenTaskListKeys に入っていない」こと ――
 * db/database.ts の getHiddenTaskLists と同じ「明示的に OFF にした集合」の考え方を
 * そのまま反映するだけで、このコンポーネント自身はデフォルト値の判断をしない。
 */
function TaskListGroup({
  accountId,
  taskLists,
  hiddenTaskListKeys,
  onToggleTaskList,
}: TaskListGroupProps) {
  if (taskLists.length === 0) return null;

  return (
    <div className="calendar-pane-group">
      <h4 className="calendar-pane-group-title">タスクリスト</h4>
      <ul className="calendar-pane-list">
        {taskLists.map((list) => {
          const checked = !hiddenTaskListKeys.has(`${accountId}:${list.id}`);
          return (
            <li className="calendar-pane-item" key={list.id}>
              <button
                type="button"
                className="calendar-pane-checkbox"
                aria-pressed={checked}
                aria-label={`${list.title}を${checked ? "非表示" : "表示"}にする`}
                onClick={() => onToggleTaskList(accountId, list.id, !checked)}
              >
                <span className={checked ? "masu masu--kichi" : "masu masu--empty"} />
              </button>
              <span className="calendar-pane-cal-name">{list.title}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface GitHubSectionProps {
  githubLogin: string | null;
  activityVisible: boolean;
  onToggleActivityVisible: () => void;
  ciVisible: boolean;
  onToggleCiVisible: () => void;
}

/**
 * GitHub セクション(左ペイン最下部、増分2、2026-07-22)。
 *
 * 接続状態の表示のみを担う ―― 連携/解除の操作はここに置かない(「選択=左ペイン /
 * 連携管理=設定パネル」の役割分担、増分1のコメント参照。CalendarSettingsPanel に
 * 既にある GitHub 連携ボタンと重複させない)。
 *
 * ツールバー煩雑さの解消(ユーザー要望)を兼ねて、App.tsx のツールバーにあった GitHub
 * 系の表示トグル2つ(実績オーバーレイ・CI/Actions 実行)をここへ移設した。state
 * (activityVisible/ciVisible、App.tsx の useState)自体は App.tsx に残したまま、
 * 置き場所(このコンポーネント)だけを変えている。右ペイン(GitHubPane、作業キュー)の
 * 開閉トグルは対象外 ―― ペインを開いていなくても件数バッジ等で常に状況が見える方が
 * 有用なため、ツールバーに残す判断(ユーザー決定、意図的な非対称)。
 */
function GitHubSection({
  githubLogin,
  activityVisible,
  onToggleActivityVisible,
  ciVisible,
  onToggleCiVisible,
}: GitHubSectionProps) {
  return (
    <div className="calendar-pane-github">
      <h4 className="calendar-pane-group-title">GitHub</h4>
      {githubLogin ? (
        <>
          <p className="calendar-pane-github-status">@{githubLogin} と連携中</p>
          <ul className="calendar-pane-list">
            <li className="calendar-pane-item">
              <button
                type="button"
                className="calendar-pane-checkbox"
                aria-pressed={activityVisible}
                aria-label={`GitHub 実績表示を${activityVisible ? "オフ" : "オン"}にする`}
                onClick={onToggleActivityVisible}
              >
                <span className={activityVisible ? "masu masu--kichi" : "masu masu--empty"} />
              </button>
              <span className="calendar-pane-cal-name">実績オーバーレイ</span>
            </li>
            <li className="calendar-pane-item">
              <button
                type="button"
                className="calendar-pane-checkbox"
                aria-pressed={ciVisible}
                aria-label={`GitHub CI 表示を${ciVisible ? "オフ" : "オン"}にする`}
                onClick={onToggleCiVisible}
              >
                <span className={ciVisible ? "masu masu--kichi" : "masu masu--empty"} />
              </button>
              <span className="calendar-pane-cal-name">CI/Actions 実行</span>
            </li>
          </ul>
        </>
      ) : (
        <p className="calendar-pane-empty">
          設定パネルから連携すると GitHub の予定・実績が使えます
        </p>
      )}
    </div>
  );
}
