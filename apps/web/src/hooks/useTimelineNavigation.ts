import { useCallback, useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { isViewAllowedForWidth, type View } from "../keyboard/shortcuts";
import { stepAnchor } from "../layout/dayGrid";
import { resolveMiniMonthNavigation } from "../layout/miniMonth";
import { mondayOf } from "../layout/monthGrid";
import { readStored, writeStored } from "../layout/localStore";
import { dayCountForView, initialTimelineStart, isView } from "../layout/viewRange";

/**
 * 「今どの期間を見ているか」(view / timelineStart / monthCursor)とその移動操作だけを持つフック。
 *
 * なぜ切り出したか(リファクタリング フェーズ2 ①、2026-07-25): App.tsx は state+fetch+handler+
 * effect が7ドメイン分交互に並んで約3400行あり、そのうちこの塊だけは fetch / IndexedDB / store に
 * 一切触らない「閉じた」ものだった ―― 外部 I/O を持たないので、まず最初に切り離せる。
 *
 * モバイル対応フェーズ2(docs/multiplatform.md): 週ビュー('week')に加えて、狭幅向けの
 * N日タイムライン(day3=3日、day1=1日)がある。'month' は従来通り別レイアウト。
 * WeekGrid はこのうち 'month' 以外を dayCount 可変の同一グリッドとして描画する。
 * View 型そのものは keyboard/shortcuts.ts を正としてそこから import する
 * (グローバルショートカットの view 切替キーが同じ許容規則 isViewAllowedForWidth を
 * 参照する必要があるため)。view から表示範囲を導く純関数(dayCountForView /
 * initialTimelineStart / isView / timelineRangeMs)は layout/viewRange.ts にある。
 *
 * キーボードショートカットの配線は hooks/useGlobalShortcuts.ts が持つ ―― こちらは
 * 「移動そのもの」だけに責務を絞り、キー入力・他オーバーレイ抑止とは分けてある。
 */

const VIEW_STORAGE_KEY = "kichijitsu:view";

/** localStorage に保存された前回選択 view を読む。プライベートモード等で無効なら null */
function loadStoredView(): View | null {
  return readStored<View | null>(VIEW_STORAGE_KEY, (v) => (isView(v) ? v : null), null);
}

/** 初回マウント時の view の決め方(localStorage 優先、無ければ画面幅から)。useState 初期化子から呼ぶ */
function initialView(isNarrow: boolean): View {
  const stored = loadStoredView();
  if (stored && isViewAllowedForWidth(stored, isNarrow)) return stored;
  // 初回訪問(保存済み view 無し): 狭幅では Notion Calendar に倣い3日タイムラインを既定にする
  return isNarrow ? "day3" : "week";
}

// 週切替アニメーション(WeekGrid 側 SLIDE_MS=200ms)より少し長めに連打をロックする
const NAV_LOCK_MS = 220;

export interface TimelineNavigation {
  /** 表示形式。'month' 以外(week/day3/day1)は WeekGrid の N日タイムライン */
  view: View;
  /** タイムラインビュー共通の表示開始日([timelineStart, +dayCount日)を描く) */
  timelineStart: Temporal.PlainDate;
  /** 月表示ビューのカーソル。常に「月内の1日」を指す */
  monthCursor: Temporal.PlainDate;
  /** view に応じた表示日数(week=7 / day3=3 / day1=1、month では使わない) */
  dayCount: number;
  goToPrev: () => void;
  goToNext: () => void;
  goToToday: () => void;
  switchView: (next: View) => void;
  /** 月ビューのセル空き部分・「+N」クリック: その日の day1 へ */
  navigateToDay: (day: Temporal.PlainDate) => void;
  /** 左ペインのミニ月カレンダーでの日付クリック: view は変えずにその日/月へ */
  miniMonthNavigate: (date: Temporal.PlainDate) => void;
  /** スマホの横スワイプ確定: 指を離した位置に最も近い日へ、表示窓を days 日ぶんスライド
   * (正=先へ/負=前へ。0 は呼ばれない) */
  swipeNavigate: (days: number) => void;
  /** 'n' ショートカット(新規予定作成)の移動部分だけ。書き込み先の有無の判定は呼び出し側 */
  goToTodayForNewEvent: () => void;
}

/**
 * @param isNarrow 狭幅(~640px 未満)かどうか。既定 view の選択と、month からの復帰先
 *   (day1 か week か)に使う
 */
export function useTimelineNavigation({ isNarrow }: { isNarrow: boolean }): TimelineNavigation {
  // 月表示ビュー(フェーズ6)。timelineStart とは独立した状態にし、view 切替時に
  // 双方をその場で同期させる(switchView 参照)。常に「月内の1日」を指す
  const [view, setView] = useState<View>(() => initialView(isNarrow));
  // タイムラインビュー(week/day3/day1)共通の表示開始日。dayCount(view に応じて7/3/1)ぶんの
  // N日タイムラインとして WeekGrid に渡す(モバイル対応フェーズ2、docs/multiplatform.md)。
  // 初期値は view に応じる(initialTimelineStart 参照: week=今週の月曜、day3/day1=今日)
  const [timelineStart, setTimelineStart] = useState<Temporal.PlainDate>(() =>
    initialTimelineStart(view),
  );
  const [monthCursor, setMonthCursor] = useState(() =>
    Temporal.Now.plainDateISO().with({ day: 1 }),
  );
  const dayCount = dayCountForView(view);
  const navLockRef = useRef(false);

  // ユーザーが明示的に選んだ view を覚えておき、次回訪問時のデフォルトにする(任意機能)。
  // localStorage が使えない環境(プライベートモード等)では静かに無視する
  useEffect(() => {
    writeStored(VIEW_STORAGE_KEY, view);
  }, [view]);

  const withNavLock = useCallback((run: () => void) => {
    if (navLockRef.current) return;
    navLockRef.current = true;
    run();
    window.setTimeout(() => {
      navLockRef.current = false;
    }, NAV_LOCK_MS);
  }, []);

  // ナビゲーション(←/→/今日、フェーズ6で月表示・フェーズ2でday3/day1にも対応):
  // view に応じて N日送り/月送りを切り替える(N日送りは dayGrid.ts の stepAnchor に集約)
  const goToPrev = useCallback(() => {
    withNavLock(() => {
      if (view === "month") setMonthCursor((m) => m.subtract({ months: 1 }));
      else setTimelineStart((t) => stepAnchor(t, dayCount, -1));
    });
  }, [view, dayCount, withNavLock]);

  const goToNext = useCallback(() => {
    withNavLock(() => {
      if (view === "month") setMonthCursor((m) => m.add({ months: 1 }));
      else setTimelineStart((t) => stepAnchor(t, dayCount, 1));
    });
  }, [view, dayCount, withNavLock]);

  /**
   * スマホでのスワイプ日付移動(モバイル対応フェーズ2 増分、2026-07-22。スワイプは1日ずつに変更、
   * 2026-07-23。日単位スナップ = 動かした量に応じた日数へ変更、2026-07-26)。
   * WeekGrid.tsx が横スワイプの確定を検知したときに、動かす日数(正=先へ/負=前へ)を渡して呼ぶ。
   * ツールバーの ←/→ ボタン(goToPrev/goToNext)は dayCount ぶんの「ページ移動」のままだが、
   * スワイプは「指を離した位置に最も近い日」へスライドさせる(layout/swipeNav.ts resolveSwipeDays)
   * ―― 1日固定だと 1.5 日ぶん動かしても1日しか進まず、strip が指より手前へ戻る「スナップしそうな
   * 所で戻される」体感になっていた。WeekGrid のスライド量一般化(baseStripPercent / slideDays)と
   * 対で機能する。月表示(MonthView)はストリップ構造を持たないため対象外(WeekGrid のみに
   * 渡す)。nav ロック(withNavLock)は使わない: スワイプは WeekGrid 側の slideDays===0 gate で自己
   * 直列化されており、ロックで commit が握り潰されると指追従オフセットが戻らなくなるため、常に
   * setTimelineStart を発火させて WeekGrid の効果を必ず走らせる。
   */
  const swipeNavigate = useCallback((days: number) => {
    if (days === 0) return;
    setTimelineStart((t) => t.add({ days }));
  }, []);

  const goToToday = useCallback(() => {
    withNavLock(() => {
      if (view === "month") setMonthCursor(Temporal.Now.plainDateISO().with({ day: 1 }));
      else if (view === "week") setTimelineStart(mondayOf(Temporal.Now.plainDateISO()));
      // day3/day1: 今日を先頭日にする(週ビューのように月曜へ揃える概念が無いため)
      else setTimelineStart(Temporal.Now.plainDateISO());
    });
  }, [view, withNavLock]);

  // ビュー切替(週/月/3日/1日、フェーズ2でday3/day1を追加)。切替の瞬間、もう一方の状態を
  // 今表示中の期間に同期させることで、トグルしても「だいたい同じ期間を見ている」体験を保つ:
  // - タイムライン→month: 表示中の先頭日が属する月へ
  // - month→タイムライン: 表示中の月の1日へ(week だけは月曜に揃え直す)
  // - タイムライン同士(week⇔day3⇔day1): 先頭日はそのまま(dayCount の解釈だけ変わる)
  const switchView = useCallback(
    (next: View) => {
      if (view === next) return;
      withNavLock(() => {
        if (next === "month") {
          setMonthCursor(timelineStart.with({ day: 1 }));
        } else if (view === "month") {
          setTimelineStart(next === "week" ? mondayOf(monthCursor) : monthCursor);
        }
        setView(next);
      });
    },
    [view, timelineStart, monthCursor, withNavLock],
  );

  // 月ビューのセル空き部分・「+N」クリック(フェーズ6、フェーズ2でday1へ変更):
  // その日の day1(1日タイムライン)へ切り替える = アジェンダ的動線(docs/multiplatform.md)
  const navigateToDay = useCallback(
    (day: Temporal.PlainDate) => {
      withNavLock(() => {
        setTimelineStart(day);
        setView("day1");
      });
    },
    [withNavLock],
  );

  // 左ペインのミニ月カレンダー(左ペイン増分2)での日付クリック。navigateToDay と
  // 違い view 自体は切り替えない ―― 「今の表示形式のまま、その日/月へ動く」というミニ
  // カレンダー本来の役割(月表示中に day1 へ飛ばされると、ミニカレンダーで月をブラウズ
  // しているだけのつもりが表示形式まで変わってしまい驚きが大きいため)。view に応じて
  // timelineStart/monthCursor のどちらをどう動かすかは layout/miniMonth.ts の
  // resolveMiniMonthNavigation(switchView/goToToday と同じ規則)に委譲する
  const miniMonthNavigate = useCallback(
    (date: Temporal.PlainDate) => {
      withNavLock(() => {
        const target = resolveMiniMonthNavigation(view, date);
        if (target.kind === "month") setMonthCursor(target.date);
        else setTimelineStart(target.date);
      });
    },
    [view, withNavLock],
  );

  // 'n' ショートカット(新規予定作成、フェーズ6)の移動部分。理想は「今日の次の30分枠に作成入力を
  // 自動で開く」ことだが、作成入力(タイトル入力欄・draft state)は DayColumn.tsx が
  // ローカルに持っており、App からは直接開けない。ここでは簡易実装として「今日を含む
  // タイムラインビューへ移動する」にとどめ、そこから空き領域クリック/ドラッグで
  // 作成できる状態を用意する。
  // 「書き込み先カレンダーが無ければ何もしない」というガード(defaultWriteTarget)は、この
  // フックが同期系の state を知らずに済むよう呼び出し側(App.tsx の handleNewEventShortcut)に残す。
  // TODO: DayColumn の draft state を App まで持ち上げる(または WeekGrid に
  // 「起動時に指定 ms で作成入力を自動オープンする」imperative な API を持たせる)と、
  // 実際に入力欄まで自動で開けるようになる。
  const goToTodayForNewEvent = useCallback(() => {
    withNavLock(() => {
      const targetView: View = view === "month" ? (isNarrow ? "day1" : "week") : view;
      setView(targetView);
      setTimelineStart(
        targetView === "week" ? mondayOf(Temporal.Now.plainDateISO()) : Temporal.Now.plainDateISO(),
      );
    });
  }, [view, isNarrow, withNavLock]);

  return {
    view,
    timelineStart,
    monthCursor,
    dayCount,
    goToPrev,
    goToNext,
    goToToday,
    switchView,
    navigateToDay,
    miniMonthNavigate,
    swipeNavigate,
    goToTodayForNewEvent,
  };
}
