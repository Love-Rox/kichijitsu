import { useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { AccountDTO, CalendarListEntryDTO, TaskListDTO } from "@kichijitsu/shared";
import type { VisibleCalendarsMap } from "../db/database";
import { groupCalendarsByAccess } from "../sync/calendarGroups";
import type { View } from "../keyboard/shortcuts";
import { MiniMonthCalendar } from "./MiniMonthCalendar";
import "./CalendarPane.css";

export interface CalendarPaneProps {
  onClose: () => void;
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

  // ---- 作業キュー・レポート(ヘッダー整理+左ペイン常設化、増分3、2026-07-22) ----
  /**
   * 右ペイン(GitHubPane、作業キュー)の開閉状態とトグル。ツールバーの「作業キュー」ボタンを
   * ここへ移設したもの ―― me.github ゲート(GitHub 未連携なら出さない)は
   * githubLogin と同じ条件のため、呼び出し側(App.tsx)ではなくこのコンポーネント側で
   * githubLogin の有無に合わせて表示/非表示を切り替える。
   */
  githubPaneOpen: boolean;
  onToggleGitHubPane: () => void;
  /** 作業キューの件数バッジ(0件なら出さない、旧 toolbar-queue-badge と同じ挙動) */
  githubQueueCount: number;
  /**
   * 予定 vs 実績レポート(TimeReportOverlay)の開閉状態とトグル。ローカルのみのデータのため
   * GitHub 未連携でも出す現状維持 ―― githubLogin の分岐に関わらず常に表示する
   * (下の GitHubSection「時間記録」小見出し参照)。
   */
  reportOpen: boolean;
  onToggleReport: () => void;
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
 * 「ヘッダー整理+左ペイン常設化」(増分3、2026-07-22)でオーバーレイ方式を廃止した
 * (ユーザー明示要望)。開いている間は常に .app-main の flex 子として docked 表示され、
 * 外側クリック・Escape での自動クローズも無い(× ボタンか、ツールバーの「カレンダー」
 * トグルからのみ閉じられる)。狭幅(isNarrow)でも docked のまま ―― グリッドが窮屈になるのは
 * 許容し、ペイン幅だけ CSS 側で絞る(CalendarPane.css の @media (max-width: 640px) 参照)。
 * GitHubPane(右ペイン)は引き続き docked/overlay 両対応のままなので非対称になったが、
 * これは意図的(paneMode.ts のコメント参照)。
 *
 * アカウントごとにセクション化し(email 見出し、折りたたみ可・状態は localStorage 永続)、
 * 各セクション内をさらに accessRole で「マイカレンダー」(owner)と「他のカレンダー」
 * (writer/reader/freeBusyReader/未設定 ―― 祝日・購読・同僚のカレンダー等)に分ける
 * (groupCalendarsByAccess、sync/calendarGroups.ts の純関数)。各行は既存の枡チェック
 * (カレンダー色)+カレンダー名で、トグルは onToggleCalendar(App.tsx の handleToggleCalendar)を
 * そのまま呼ぶだけ ―― データ変更ロジックはこのコンポーネントには一切無い。
 *
 * ペイン内は body 上から以下のセクション構成(増分2→増分3で拡張):
 *   1. ミニ月カレンダー(MiniMonthCalendar) ―― タイムラインナビゲーション
 *   2. カレンダー選択(上記、増分1からの既存部分)
 *   3. アカウントごとのタスクリスト選択(TaskListGroup、AccountSection 内)
 *   4. GitHub セクション(GitHubSection、body 最下部) ―― 接続状態表示 + 表示トグル +
 *      作業キュー導線 + 時間記録(レポート)導線(増分3でツールバーから移設)
 *   5. フッター(プライバシー/規約リンク、増分3でツールバーから移設。body の外 ―― スクロール
 *      に埋もれず常に見える位置に固定する)
 * body 自体は calendar-pane-body の overflow-y: auto で縦スクロールする(CalendarPane.css)ため、
 * セクションがどれだけ増えても狭幅 docked 内に収まる。
 */
export function CalendarPane({
  onClose,
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
  githubPaneOpen,
  onToggleGitHubPane,
  githubQueueCount,
  reportOpen,
  onToggleReport,
}: CalendarPaneProps) {
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

  return (
    <div className="calendar-pane calendar-pane--docked" aria-label="カレンダー">
      <div className="calendar-pane-header">
        <span className="calendar-pane-title">カレンダー</span>
        <div className="calendar-pane-actions">
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
          githubPaneOpen={githubPaneOpen}
          onToggleGitHubPane={onToggleGitHubPane}
          githubQueueCount={githubQueueCount}
          reportOpen={reportOpen}
          onToggleReport={onToggleReport}
        />
      </div>

      {/*
       * Google 審査要件の導線(プライバシーポリシー・規約、増分3でツールバーから移設)。
       * body の外(flex: none)に置くことで、カレンダー/タスクリストがどれだけ増えて
       * body がスクロールしても常に最下部に固定表示される(CalendarPane.css 参照)。
       * ペインが閉じている、または未ログイン(accounts.length===0)のときはこのペイン自体が
       * マウントされない ―― その場合の到達性は App.tsx 側のツールバーフォールバックが担う
       * (App.tsx の toolbar-legal フォールバックのコメント参照)。
       */}
      <div className="calendar-pane-footer">
        <a href="/privacy.html">プライバシー</a>
        <a href="/terms.html">規約</a>
      </div>
    </div>
  );
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
  // ---- 作業キュー・レポート(増分3、CalendarPaneProps のコメント参照) ----
  githubPaneOpen: boolean;
  onToggleGitHubPane: () => void;
  githubQueueCount: number;
  reportOpen: boolean;
  onToggleReport: () => void;
}

/**
 * GitHub セクション(左ペイン最下部、増分2、2026-07-22)。
 *
 * 接続状態の表示のみを担う ―― 連携/解除の操作はここに置かない(「選択=左ペイン /
 * 連携管理=設定パネル」の役割分担、増分1のコメント参照。CalendarSettingsPanel に
 * 既にある GitHub 連携ボタンと重複させない)。
 *
 * ツールバー煩雑さの解消(ユーザー要望)を兼ねて、App.tsx のツールバーにあった GitHub
 * 系の表示トグル2つ(実績オーバーレイ・CI/Actions 実行)を増分2でここへ移設した。state
 * (activityVisible/ciVisible、App.tsx の useState)自体は App.tsx に残したまま、
 * 置き場所(このコンポーネント)だけを変えている。
 *
 * 増分3(2026-07-22、ヘッダー整理+左ペイン常設化)でさらに2つ移設した:
 *   - 「作業キュー」(右ペイン GitHubPane の開閉トグル + 件数バッジ)。GitHub 連携が前提の
 *     機能のため、githubLogin ブロック内(連携済みのときだけ)に置く ―― 旧ツールバーの
 *     me.github ゲートと同じ条件をこのコンポーネント内の分岐がそのまま引き継ぐ形になる。
 *     増分2時点では「ペインを開いていなくても件数バッジで状況が見える方が有用」という
 *     理由でツールバーに残していたが、ヘッダー整理を優先する今回のユーザー決定で
 *     こちらへ移す(バッジ自体は引き続き0件のときは出さない、旧 toolbar-queue-badge と同じ)。
 *   - 「時間記録」(レポート、TimeReportOverlay の開閉トグル)。ローカルのみのデータのため
 *     GitHub 未連携でも意味を持つ機能 ―― githubLogin の分岐の外に独立した小見出しとして置き、
 *     連携有無に関わらず常に表示する(旧ツールバーのボタンが me.github ゲート無しだった
 *     挙動をそのまま踏襲)。
 */
function GitHubSection({
  githubLogin,
  activityVisible,
  onToggleActivityVisible,
  ciVisible,
  onToggleCiVisible,
  githubPaneOpen,
  onToggleGitHubPane,
  githubQueueCount,
  reportOpen,
  onToggleReport,
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
          <button
            type="button"
            className="calendar-pane-action-btn"
            onClick={onToggleGitHubPane}
            aria-expanded={githubPaneOpen}
            aria-haspopup="dialog"
            aria-label="作業キュー"
            title="作業キュー"
          >
            <span>作業キュー(右ペインを開く)</span>
            {githubQueueCount > 0 && (
              <span className="calendar-pane-action-badge">{githubQueueCount}</span>
            )}
          </button>
        </>
      ) : (
        <p className="calendar-pane-empty">
          設定パネルから連携すると GitHub の予定・実績が使えます
        </p>
      )}
      {/*
       * 「時間記録」小見出し(増分3)。GitHub セクションの見出し構成(接続状態前提)に
       * レポート機能がそぐわないため、独立した小見出しを設けて githubLogin 分岐の外に置く
       * ―― 未連携でも常に表示する(上のコメント参照)。
       */}
      <div className="calendar-pane-group">
        <h4 className="calendar-pane-group-title">時間記録</h4>
        <button
          type="button"
          className="calendar-pane-action-btn"
          onClick={onToggleReport}
          aria-expanded={reportOpen}
          aria-haspopup="dialog"
          aria-label="予定 vs 実績レポート"
          title="予定 vs 実績レポート"
        >
          <span>レポート</span>
        </button>
      </div>
    </div>
  );
}
