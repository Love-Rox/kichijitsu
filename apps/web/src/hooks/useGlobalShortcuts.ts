import { useEffect } from "react";
import { isEditableTarget, resolveShortcut, type View } from "../keyboard/shortcuts";

/**
 * グローバルキーボードショートカット(フェーズ6)の window リスナー配線だけを持つフック。
 *
 * キー→アクションの対応表自体は keyboard/shortcuts.ts の純関数 (resolveShortcut) にあり、
 * テストはそちらで行う。移動そのものは hooks/useTimelineNavigation.ts が持つ。ここは
 * 「入力中の抑止 / 他オーバーレイの抑止 / ディスパッチ」という DOM 寄りの責務だけを担う。
 *
 * ハンドラを個別の関数として受け取る形にしてあるのは、useEffect の依存配列を
 * 切り出し前(App.tsx)とまったく同じ粒度に保つため ―― 呼び出し側の useCallback の
 * 同一性がそのまま「リスナーを張り替えるかどうか」に対応する。
 */
export interface GlobalShortcutsOptions {
  /** 狭幅かどうか。resolveShortcut が w/m/d/1/3 の許容判定に使う */
  isNarrow: boolean;
  /** ヘルプオーバーレイが開いているか(Escape で閉じるかの判定に使う) */
  helpOpen: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSwitchView: (view: View) => void;
  onNewEvent: () => void;
  /** '?' キー。ヘルプの開閉をトグルする */
  onToggleHelp: () => void;
  /** Escape キー。helpOpen が true のときだけ呼ばれる */
  onCloseHelp: () => void;
}

export function useGlobalShortcuts({
  isNarrow,
  helpOpen,
  onPrev,
  onNext,
  onToday,
  onSwitchView,
  onNewEvent,
  onToggleHelp,
  onCloseHelp,
}: GlobalShortcutsOptions): void {
  // ←/→/t は元々このハンドラが持っていたもの(WeekGrid 側は ←/→/t を処理していない、
  // 二重登録なし)に、w/m/d/1/3(ビュー切替)・n(新規予定)・?(ヘルプ)・Escape
  // (ヘルプを閉じる)を追加したもの。ここでは:
  //   1. 入力中(input/textarea/contenteditable)なら常に無視
  //   2. Escape は最前面のオーバーレイ(ヘルプ)だけを閉じる。詳細ポップオーバー・設定モーダルは
  //      各自の Escape リスナー (useCloseOnOutsideOrEscape、SettingsModal も含め全オーバーレイが
  //      共通で使う) が既に閉じるので、ここでは二重に処理しない
  //   3. それ以外のショートカットは、詳細ポップオーバー・設定モーダル・ヘルプが開いている間は
  //      発火させない(作成入力は <input> なので 1. のガードで既にカバーされている)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (isEditableTarget(target?.tagName ?? null, target?.isContentEditable ?? false)) return;

      const action = resolveShortcut(e, isNarrow);
      if (!action) return;

      if (action.kind === "escape") {
        if (helpOpen) onCloseHelp();
        return;
      }

      // 他のオーバーレイ(詳細ポップオーバー・設定モーダル・予定検索・ヘルプ自身など)が
      // 開いている間は無視する。個別に state/class を列挙せず role="dialog" を共通の
      // 目印にする(EventDetailCard/SettingsModal/SearchOverlay/KeyboardHelpOverlay は
      // いずれも role="dialog" を持つ、既存の流儀)。これにより新しいオーバーレイが増えても
      // ここを更新し忘れる心配がない。
      if (document.querySelector('[role="dialog"]')) return;

      switch (action.kind) {
        case "prev":
          onPrev();
          break;
        case "next":
          onNext();
          break;
        case "today":
          onToday();
          break;
        case "switchView":
          onSwitchView(action.view);
          break;
        case "newEvent":
          onNewEvent();
          break;
        case "toggleHelp":
          onToggleHelp();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    onPrev,
    onNext,
    onToday,
    onSwitchView,
    onNewEvent,
    onToggleHelp,
    onCloseHelp,
    isNarrow,
    helpOpen,
  ]);
}
