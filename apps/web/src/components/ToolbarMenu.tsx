import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { HourHeightControl } from "./HourHeightControl";
import { MasuIndicator } from "./MasuIndicator";
import { CalendarIcon, GearIcon, MoreIcon, TimerIcon } from "./icons";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import type { MasuVisibleState } from "../hooks/useMasuVisible";
import {
  buildToolbarMenuItems,
  type ToolbarMenuIconId,
  type ToolbarMenuInput,
} from "./toolbarMenuItems";
import "./ToolbarMenu.css";

export interface ToolbarMenuProps extends ToolbarMenuInput {
  /** ズーム行に埋め込む HourHeightControl の現在値 */
  hourHeight: number;
  onHourHeightChange: (next: number) => void;
  /**
   * 注意を促す文言(同期失敗・保存失敗)。広幅ではヘッダーに赤字で出ていたもので、
   * メニュー内に文言を出しつつ ⋯ ボタンには赤いドットだけを付けて気付けるようにする。
   */
  notes: string[];
  /**
   * 同期中の枡インジケーター(useMasuVisible)。同期ボタン自体をメニューへ畳んだため、
   * 「押した/動いている」というフィードバックが消えないように ⋯ ボタンの脈動ドットと
   * 同期行の枡の両方をこの状態で出す。枡そのものは幅 50px あってヘッダーには置けない。
   */
  syncIndicator: MasuVisibleState;
}

/**
 * スマホ幅(max-width: 640px)のツールバーに置く「その他」メニュー(2026-07-26、ユーザー要望
 * 「スマホでのヘッダーが収まりきらない」)。
 *
 * ## 何をここに入れたか
 * ヘッダーに常時残すのは「カレンダーを見ながら繰り返し使うもの」だけ ―― ←/今日/→、日付、
 * ビュー切替、検索、走行中タイマー、オフライン表示。それ以外(ズーム・カレンダー/実績ペイン・
 * 設定・同期・ヘルプ・Google 連携・プライバシー/規約)はこのメニューへ畳む。どの行を出すかは
 * toolbarMenuItems.ts の純関数が決める(表示条件は元の各ボタンのゲートをそのまま引き継ぐ)。
 *
 * ## role="menu" ではなく role="dialog" にした理由
 * useGlobalShortcuts が「オーバーレイが開いている間はショートカットを発火させない」判定に
 * `document.querySelector('[role="dialog"]')` を使っている(個別の state を列挙しない既存の流儀)。
 * ここを role="menu" にすると、メニューを開いたまま w/m/t/n を押すと背後のカレンダーが動いて
 * しまう ―― 既存の不変条件を静かに破ることになる。加えてズーム行にはプリセットの <select> と
 * 法的リンクの <a> が入り、これらは role="menu"/"menuitem" の意味論に収まらない。よって
 * SettingsModal / SearchOverlay / RunningTimersIndicator と同じ role="dialog" に揃える。
 *
 * ## 開いている間のカレンダー操作
 * 透明バックドロップ(.toolbar-menu-backdrop、EventDetailCard の .event-detail-backdrop と
 * 同じ作法)を敷き、外側の pointerdown を stopPropagation して「閉じるだけ」にする。これにより
 * .week-grid の横スワイプ日移動(useSwipeNavigation)にも新規作成にもイベントが届かない
 * ―― バックドロップは .week-grid の子孫ではないので、グリッドに張られたリスナーには
 * そもそも伝播しない。⋯ ボタンだけはバックドロップより上(z-index)に置き、もう一度押して
 * 閉じられるようにしてある。
 */
export function ToolbarMenu({
  hourHeight,
  onHourHeightChange,
  notes,
  syncIndicator,
  ...input
}: ToolbarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Escape で閉じる。外側クリックはバックドロップが受け止めるため、このフックの
  // pointerdown 判定はここでは実質使われない(バックドロップも rootRef の内側にあるため)。
  useCloseOnOutsideOrEscape(open, rootRef, () => setOpen(false));

  const items = buildToolbarMenuItems(input);

  return (
    <div className="toolbar-menu" ref={rootRef}>
      <button
        type="button"
        className="toolbar-menu-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="その他のメニュー"
        title="その他"
      >
        <MoreIcon width={16} height={16} />
        {/*
         * 右上の小さなドット。失敗(赤・静止)を優先し、無ければ同期中(朱・脈動)を出す。
         * 枡インジケーターそのものは幅 50px あり狭幅ヘッダーには置けないので、ここでは
         * 「何か起きている/起きた」ことだけを伝え、詳細(枡と文言)はメニューの中で見せる。
         */}
        {notes.length > 0 ? (
          <span className="toolbar-menu-dot toolbar-menu-dot--alert" aria-hidden="true" />
        ) : (
          syncIndicator.visible && (
            <span className="toolbar-menu-dot toolbar-menu-dot--busy" aria-hidden="true" />
          )
        )}
      </button>
      {open && (
        <>
          <div
            className="toolbar-menu-backdrop"
            onPointerDown={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="toolbar-menu-panel" role="dialog" aria-label="その他のメニュー">
            {notes.map((note) => (
              <p className="toolbar-menu-note" key={note}>
                {note}
              </p>
            ))}
            {items.map((item) => {
              if (item.kind === "zoom") {
                return (
                  <div className="toolbar-menu-zoom" key={item.id}>
                    <span className="toolbar-menu-zoom-label">{item.label}</span>
                    {/*
                     * 狭幅ヘッダーでは compact(プリセットのセレクトを畳んだ形)だったが、
                     * メニューの中なら幅に余裕があるのでプリセット付きの通常表示にする。
                     * 連続して押す操作なので、この行だけはクリックでメニューを閉じない。
                     */}
                    <HourHeightControl hourHeight={hourHeight} onChange={onHourHeightChange} />
                  </div>
                );
              }
              if (item.kind === "link") {
                return (
                  <a className="toolbar-menu-link" href={item.href} key={item.id}>
                    {item.label}
                  </a>
                );
              }
              return (
                <button
                  type="button"
                  className="toolbar-menu-item"
                  key={item.id}
                  onClick={() => {
                    item.onClick();
                    setOpen(false);
                  }}
                  disabled={item.disabled}
                  aria-label={item.ariaLabel}
                  title={item.title}
                  aria-expanded={item.expanded}
                >
                  <span className="toolbar-menu-item-icon" aria-hidden="true">
                    {menuIcon(item.icon)}
                  </span>
                  <span className="toolbar-menu-item-label">{item.label}</span>
                  {/* 同期中は行の右端に枡インジケーター(広幅で同期ボタンの中に出るのと同じもの) */}
                  {item.id === "sync" && syncIndicator.visible && (
                    <span
                      className={
                        syncIndicator.fading
                          ? "toolbar-menu-item-busy masu-indicator--fading"
                          : "toolbar-menu-item-busy"
                      }
                    >
                      <MasuIndicator size="sm" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 行頭アイコンの識別子 → 実体。同期(⟳)とヘルプ(?)は元のツールバーでもグリフだったので
 * そのまま流用し、Google 連携だけは対応するアイコンが無いので空(幅だけ揃える)。
 */
function menuIcon(icon: ToolbarMenuIconId): ReactNode {
  switch (icon) {
    case "calendar":
      return <CalendarIcon />;
    case "timer":
      return <TimerIcon />;
    case "gear":
      return <GearIcon width={14} height={14} />;
    case "sync":
      return "⟳";
    case "help":
      return "?";
    case "google":
      return null;
  }
}
