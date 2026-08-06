import type { Dispatch, SetStateAction } from "react";
import { HourHeightControl } from "./HourHeightControl";
import { LogoMark, LogoWordmark } from "./Logo";
import { MasuIndicator } from "./MasuIndicator";
import { RunningTimersIndicator } from "./RunningTimersIndicator";
import { ToolbarMenu } from "./ToolbarMenu";
import { buildToolbarErrorNotes } from "./toolbarErrorNotes";
import { startGoogleAuth } from "../sync/desktopAuth";
import { CalendarIcon, GearIcon, SearchIcon, TimerIcon } from "./icons";
import type { TimelineNavigation } from "../hooks/useTimelineNavigation";
import type { MasuVisibleState } from "../hooks/useMasuVisible";
import type { GoogleAccountsController } from "../hooks/useGoogleAccounts";
import type { CalendarSyncController } from "../hooks/useCalendarSync";
import type { EventMutationsController } from "../hooks/useEventMutations";
import type { TimersController } from "../hooks/useTimers";

/**
 * ヘッダーのツールバー(リファクタリング フェーズ3b、2026-07-26 に App.tsx から切り出し)。
 *
 * なぜ切り出したか: App.tsx は state/effect の配線に加えて 300行超のツールバー JSX と
 * オーバーレイ群の JSX を抱えて 1285行あり、「どこに何があるか」を追うのが難しかった。
 * ここは**表示だけ**の塊(自前の state も effect も持たない)なので、まず見た目の単位で
 * 切り出す。必要な値・ハンドラを props でそのまま受け取るだけ(props が多いのは意図的)。
 *
 * setPanelOpen / setHelpOpen は onClick のインライン記述(`() => setPanelOpen((open) => !open)`)を
 * 一字も変えずに済ませるため、ラップしたコールバックではなく setter をそのまま受け取っている。
 *
 * ## スマホ幅(isNarrow)の構成 ―― 2026-07-26、ユーザー要望「ヘッダーが収まりきらない」
 * 幅を詰める小細工(文言を隠す・パディングを絞る)を積み重ねてきたが、要素そのものが
 * 増え続けたため 320〜414px では限界だった。そこで**要素の数を減らす**方針に切り替え、
 * 狭幅では以下だけを常時表示し、残りは「その他」メニュー(ToolbarMenu)へ畳む:
 *
 *   常時表示: ロゴ枡 / ←・今日・→ / 検索 / ビュー切替 / 日付ラベル / オフライン表示 /
 *             走行中タイマー / 同期中の枡 / ⋯ メニュー
 *   メニュー: 時間軸ズーム / カレンダー(左ペイン) / 実績(右ペイン) / 設定 / 同期 /
 *             ヘルプ / Google 連携 / プライバシー・規約
 *
 * 振り分けの基準は「カレンダーを見ながら繰り返し使うか」。走行中タイマーは “いま動いている”
 * ことが一目で分かる必要があるのでメニューには入れない。オフライン表示も同じ理由で残す。
 * 同期は畳んだが、同期中であることは枡インジケーターで、失敗は ⋯ の注意ドット + メニュー内の
 * 文言で分かるようにしてある(状態のフィードバック自体は落とさない)。
 *
 * **広幅(!isNarrow)の DOM は一切変えていない** ―― 各要素を `{!isNarrow && ...}` で括った
 * だけなので、広幅では従来と同じ要素が同じ順序・同じクラス名で並ぶ。
 */
export interface AppToolbarProps {
  view: TimelineNavigation["view"];
  isNarrow: boolean;
  goToPrev: TimelineNavigation["goToPrev"];
  goToNext: TimelineNavigation["goToNext"];
  goToToday: TimelineNavigation["goToToday"];
  switchView: TimelineNavigation["switchView"];
  openSearch: () => void;
  hourHeight: number;
  handleHourHeightChange: (next: number) => void;
  monthCursor: TimelineNavigation["monthCursor"];
  timelineStart: TimelineNavigation["timelineStart"];
  offline: boolean;
  me: GoogleAccountsController["me"];
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  runSync: CalendarSyncController["runSync"];
  syncStatus: CalendarSyncController["syncStatus"];
  syncIndicator: MasuVisibleState;
  saveError: EventMutationsController["saveError"];
  leftPaneOpen: boolean;
  toggleLeftPane: () => void;
  paneOpen: boolean;
  toggleGitHubPane: () => void;
  runningTimeEntries: TimersController["runningTimeEntries"];
  timerNowMs: TimersController["timerNowMs"];
  onStopTimer: TimersController["stopTimer"];
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
}

export function AppToolbar({
  view,
  isNarrow,
  goToPrev,
  goToNext,
  goToToday,
  switchView,
  openSearch,
  hourHeight,
  handleHourHeightChange,
  monthCursor,
  timelineStart,
  offline,
  me,
  panelOpen,
  setPanelOpen,
  runSync,
  syncStatus,
  syncIndicator,
  saveError,
  leftPaneOpen,
  toggleLeftPane,
  paneOpen,
  toggleGitHubPane,
  runningTimeEntries,
  timerNowMs,
  onStopTimer,
  setHelpOpen,
}: AppToolbarProps) {
  const hasAccounts = me.accounts.length > 0;
  // 「○アカウント連携中」というラベルは何のボタンか分かりづらい (ユーザー指摘 2026-07-22) ため、
  // 歯車アイコン + 「設定」ラベルにして設定画面を開くボタンであることを前面に出す。連携中の
  // アカウント (email / 件数) は説明的な title/aria-label に退避させ、必要な人には読めるようにする。
  // 狭幅ではこの同じ文言を「その他」メニューの設定行の aria-label/title に引き継ぐ。
  const settingsLabel =
    me.accounts.length === 1
      ? `設定 (${me.accounts[0].email})`
      : `設定 (${me.accounts.length}アカウント連携中)`;
  // 広幅ではヘッダーに赤字で出していた失敗表示。狭幅ではメニューの中に文言を出し、
  // ⋯ ボタンには注意ドットだけを付ける(ToolbarMenu.tsx 参照)。
  //
  // Google 再認証が必要 (2026-08-06、本番障害対応) もここに混ぜる ―― refresh_token 失効は
  // そのアカウントの同期が完全に止まる深刻な状態なのに、設定モーダルを開かない限り
  // 気づけないのでは遅い。文言の組み立て自体は React 非依存の純関数
  // (toolbarErrorNotes.ts) に切り出してテストしてある。実際に再認証する導線 (再連携ボタン)
  // は設定モーダルの AccountsSection に置く ―― 複数アカウントがありうるので一覧 UI の
  // ほうが導線として自然なため、ここでは「気づく」だけを担う。
  const errorNotes = buildToolbarErrorNotes({
    syncFailed: syncStatus === "error",
    saveFailed: Boolean(saveError),
    reauthRequiredEmails: me.accounts.filter((a) => a.reauthRequired).map((a) => a.email),
  });

  return (
    <header className="toolbar">
      <div className="logo-lockup">
        <LogoMark />
        <LogoWordmark />
      </div>
      <div className="toolbar-nav">
        <button
          type="button"
          onClick={goToPrev}
          aria-label={view === "week" ? "前週" : view === "month" ? "前月" : "前へ"}
        >
          ←
        </button>
        <button type="button" onClick={goToToday}>
          今日
        </button>
        <button
          type="button"
          onClick={goToNext}
          aria-label={view === "week" ? "次週" : view === "month" ? "次月" : "次へ"}
        >
          →
        </button>
        {/* 予定検索(フェーズ6)。SearchOverlay 側で入力欄にオートフォーカスする。
         * アイコンは 2026-07-22 に絵文字 🔍 から SearchIcon(フラット SVG)へ置き換え */}
        <button type="button" onClick={openSearch} aria-label="予定を検索">
          <SearchIcon />
        </button>
      </div>
      {/*
       * ビュー切替(フェーズ6で週/月、フェーズ2でday3/day1を追加、docs/multiplatform.md)。
       * 狭幅では Notion Calendar に倣い「1日/3日/月」を出し、広幅では従来通り「週/月」のまま
       * (3日は任意扱いとして広幅ツールバーには出さない)。
       */}
      <div className="toolbar-view-toggle" role="group" aria-label="表示切替">
        {isNarrow ? (
          <>
            <button
              type="button"
              className={view === "day1" ? "is-active" : ""}
              aria-pressed={view === "day1"}
              onClick={() => switchView("day1")}
            >
              1日
            </button>
            <button
              type="button"
              className={view === "day3" ? "is-active" : ""}
              aria-pressed={view === "day3"}
              onClick={() => switchView("day3")}
            >
              3日
            </button>
            <button
              type="button"
              className={view === "month" ? "is-active" : ""}
              aria-pressed={view === "month"}
              onClick={() => switchView("month")}
            >
              月
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={view === "week" ? "is-active" : ""}
              aria-pressed={view === "week"}
              onClick={() => switchView("week")}
            >
              週
            </button>
            <button
              type="button"
              className={view === "month" ? "is-active" : ""}
              aria-pressed={view === "month"}
              onClick={() => switchView("month")}
            >
              月
            </button>
          </>
        )}
      </div>
      {/*
       * 時間軸ズーム(2026-07-25、ユーザー要望)。「表示の粗さ」を決める操作なので
       * ビュー切替(週/月・1日/3日/月)のセグメントの直後に置く ―― 同じ「表示の見え方」を
       * 変える操作をツールバーの同じ塊にまとめる。時間軸を持たない月表示では出さない。
       * 狭幅ではヘッダーに置かず「その他」メニューへ畳む(そちらではプリセットのセレクトも
       * 一緒に出せるので、compact 表示より操作しやすい)。
       */}
      {!isNarrow && view !== "month" && (
        <HourHeightControl hourHeight={hourHeight} onChange={handleHourHeightChange} />
      )}
      <div className="toolbar-right">
        {/*
         * モバイル狭幅対応: 年月表示を「7月」/「7/20」まで縮める(スマホヘッダー1段化)。
         * 広幅は従来通りフル表記のまま(isNarrow は既存の useMediaQuery state を流用するだけで
         * ロジックの追加は無い)。
         */}
        <span className="month-label">
          {view === "month" ? (
            isNarrow ? (
              <>{monthCursor.month}月</>
            ) : (
              <>
                {monthCursor.year}年{monthCursor.month}月
              </>
            )
          ) : view === "day1" ? (
            isNarrow ? (
              <>
                {timelineStart.month}/{timelineStart.day}
              </>
            ) : (
              <>
                {timelineStart.year}年{timelineStart.month}月{timelineStart.day}日
              </>
            )
          ) : isNarrow ? (
            <>{timelineStart.month}月</>
          ) : (
            <>
              {timelineStart.year}年{timelineStart.month}月
            </>
          )}
        </span>
        {offline && (
          <span
            className="offline-indicator"
            title="サーバーに接続できません。表示はローカルに保存されたデータです"
          >
            <span className="masu masu--empty" aria-hidden="true" />
            <span className="offline-indicator-label">オフライン</span>
          </span>
        )}
        {!isNarrow && (
          <div className="toolbar-account">
            {hasAccounts ? (
              <>
                <button
                  type="button"
                  className="account-summary"
                  onClick={() => setPanelOpen((open) => !open)}
                  aria-expanded={panelOpen}
                  aria-haspopup="dialog"
                  title={settingsLabel}
                  aria-label={settingsLabel}
                >
                  <span className="account-gear" aria-hidden="true">
                    <GearIcon width={16} height={16} />
                  </span>
                  <span className="account-summary-label">設定</span>
                </button>
                <button
                  type="button"
                  className="toolbar-sync-btn"
                  onClick={runSync}
                  disabled={syncStatus === "syncing"}
                  aria-label="同期"
                  title="同期"
                >
                  {syncIndicator.visible ? (
                    <span
                      className={
                        syncIndicator.fading
                          ? "sync-indicator masu-indicator--fading"
                          : "sync-indicator"
                      }
                    >
                      <MasuIndicator size="sm" />
                      同期中
                    </span>
                  ) : (
                    "同期"
                  )}
                </button>
                {errorNotes.map((note) => (
                  <span className="sync-error" key={note}>
                    {note}
                  </span>
                ))}
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  // ブラウザ/PWA では従来どおり `/auth/login` へ同一ウィンドウ遷移する。
                  // デスクトップ版 (Tauri) だけ外部ブラウザで開く ―― Google が埋め込み
                  // webview からの OAuth を禁止しており 401: disabled_client になるため
                  // (sync/desktopAuth.ts の冒頭コメント参照)。
                  void startGoogleAuth({ kind: "login" });
                }}
              >
                Google 連携
              </button>
            )}
          </div>
        )}
        {/*
         * 左ペイン「カレンダー」(CalendarPane、カレンダーナビゲーション増分1)の開閉導線。
         * 連携アカウントが1件も無ければ出す意味が無い(CalendarPane 自体は「連携中の
         * アカウントがありません」を表示できるが、導線自体を隠した方が分かりやすい ――
         * GitHubPane の me.github ゲートと同じ考え方)。狭幅ではメニューへ移設。
         */}
        {!isNarrow && hasAccounts && (
          <button
            type="button"
            className="toolbar-calendar-btn"
            onClick={toggleLeftPane}
            aria-label="カレンダー"
            title="カレンダー"
            aria-expanded={leftPaneOpen}
            aria-haspopup="dialog"
          >
            {/* 2026-07-22: 絵文字 📅 から CalendarIcon(フラット SVG)へ置き換え */}
            <span aria-hidden="true">
              <CalendarIcon />
            </span>
            <span className="toolbar-calendar-label">カレンダー</span>
          </button>
        )}
        {/*
         * 「実績」ボタン(実績 UX 刷新、2026-07-23 → 2026-07-25 に右ペイントグルへ変更)。
         * 実績の記録/タイマー/履歴は右ペイン(GitHubPane)に集約されたため、このボタンは
         * モーダルではなく右ペインの開閉トグルになった(paneOpen を共有 ―― CalendarPane の
         * 「作業キュー」ボタンと同じ state)。表示条件はペインの描画条件(me.github)と
         * 揃える ―― GitHub 未連携で押しても何も開かない、という状態を作らないため。
         * 狭幅ではメニューへ移設。
         */}
        {!isNarrow && me.github && (
          <button
            type="button"
            className="toolbar-actuals-btn"
            onClick={toggleGitHubPane}
            aria-label="実績(記録・タイマー・履歴)"
            title="実績(右ペインを開く: 実行中・作業キュー・記録・履歴)"
            aria-expanded={paneOpen}
          >
            <span aria-hidden="true">
              <TimerIcon />
            </span>
            <span className="toolbar-actuals-label">実績</span>
          </button>
        )}
        {/*
         * 走行中タイマーのインジケーター(増分2)。me 連携有無に関係なく、走行中エントリが
         * 1件でもあれば表示する(コンポーネント自身が0件時に null を返す)。狭幅でも
         * メニューには畳まない ―― 「いま計測が動いている」ことは一目で分かる必要がある。
         */}
        <RunningTimersIndicator
          runningEntries={runningTimeEntries}
          nowMs={timerNowMs}
          onStop={onStopTimer}
        />
        {/* キーボードショートカット ヘルプ(フェーズ6)。'?' キーと同じトグル。
            狭幅ではメニューへ移設(物理キーボードのある広幅が主な出番のため) */}
        {!isNarrow && (
          <button
            type="button"
            className="toolbar-help-btn"
            onClick={() => setHelpOpen((v) => !v)}
            aria-label="キーボードショートカット一覧"
            title="キーボードショートカット (?)"
          >
            ?
          </button>
        )}
        {/*
         * プライバシー/規約リンクは増分3で CalendarPane のフッターへ移設したが、
         * CalendarPane 自体は `me.accounts.length > 0` ゲートの内側(未ログイン時は
         * マウントされない)なので、未ログインの訪問者には規約リンクへの導線が一切
         * 無くなってしまう ―― Google 審査要件上、法的リンクは常時到達可能でなければ
         * ならないため、未ログイン時(accounts.length === 0)だけツールバーの従来位置に
         * フォールバック表示する。ログイン後は CalendarPane 側にしか出さない(重複を避ける)。
         * 狭幅ではこのフォールバックも出さず、代わりに「その他」メニューが**連携状態に
         * 関わらず常に**両リンクを持つ(toolbarMenuItems.ts 参照)ので到達性は保たれる。
         */}
        {!isNarrow && !hasAccounts && (
          <div className="toolbar-legal toolbar-legal--fallback">
            <a href="/privacy.html">プライバシー</a>
            <a href="/terms.html">規約</a>
          </div>
        )}
        {/*
         * 狭幅の「その他」メニュー(2026-07-26)。上で `!isNarrow &&` により隠した操作は
         * すべてここに入る ―― onClick / aria-label / title / aria-expanded は元のボタンの
         * ものをそのまま引き継いでいる(ToolbarMenu.tsx / toolbarMenuItems.ts 参照)。
         */}
        {isNarrow && (
          <ToolbarMenu
            hasAccounts={hasAccounts}
            hasGitHub={Boolean(me.github)}
            hasTimeAxis={view !== "month"}
            syncing={syncStatus === "syncing"}
            settingsLabel={settingsLabel}
            leftPaneOpen={leftPaneOpen}
            paneOpen={paneOpen}
            onToggleLeftPane={toggleLeftPane}
            onToggleGitHubPane={toggleGitHubPane}
            onOpenSettings={() => setPanelOpen((open) => !open)}
            onSync={runSync}
            onToggleHelp={() => setHelpOpen((v) => !v)}
            onConnectGoogle={() => {
              // 広幅の「Google 連携」ボタンと同じ経路 (上のコメント参照)。
              void startGoogleAuth({ kind: "login" });
            }}
            hourHeight={hourHeight}
            onHourHeightChange={handleHourHeightChange}
            notes={errorNotes}
            syncIndicator={syncIndicator}
          />
        )}
      </div>
    </header>
  );
}
