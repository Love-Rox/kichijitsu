/**
 * グローバルキーボードショートカット(フェーズ6)の「キー入力 → アクション」対応表を
 * 純関数として切り出したもの。DOM/React に依存しないため単体テストしやすい
 * (dayGrid.ts/gridMetrics.ts と同じ流儀)。実際のディスパッチ(goToPrev 等の呼び出し・
 * オーバーレイが開いている間のガード)は App.tsx が担う。
 */

/** App.tsx の View と同じもの(循環 import を避けるためここが正とし、App.tsx から参照する) */
export type View = 'week' | 'month' | 'day3' | 'day1'

export type ShortcutAction =
  | { kind: 'prev' }
  | { kind: 'next' }
  | { kind: 'today' }
  | { kind: 'switchView'; view: View }
  | { kind: 'newEvent' }
  | { kind: 'toggleHelp' }
  | { kind: 'escape' }

/** KeyboardEvent から必要な部分だけを抜き出した最小限の形(テストでは実 DOM Event を作らずに済む) */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/**
 * フォーカス中の要素が「入力中」とみなされるかどうか。input/textarea/contenteditable の
 * どれかにフォーカスがある間はショートカットを一切発火させない(App.tsx の keydown ハンドラが
 * このガードを最初に見る)。tagName は大文字("INPUT" 等)を想定(HTMLElement.tagName の仕様どおり)。
 */
export function isEditableTarget(tagName: string | null | undefined, isContentEditable: boolean): boolean {
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || isContentEditable
}

/**
 * 狭幅/広幅それぞれで toolbar のビュー切替ボタンに出せる(≒意味のある)view かどうか。
 * App.tsx の isViewAllowedForWidth と同じ規則(App.tsx はここから import して使う、
 * 二重定義によるドリフトを避けるため単一の実装元にしてある)。
 */
export function isViewAllowedForWidth(view: View, narrow: boolean): boolean {
  if (view === 'month') return true
  return narrow ? view === 'day3' || view === 'day1' : view === 'week'
}

function switchViewIfAllowed(view: View, isNarrow: boolean): ShortcutAction | null {
  return isViewAllowedForWidth(view, isNarrow) ? { kind: 'switchView', view } : null
}

/**
 * キー入力からショートカットアクションを解決する。
 * - Ctrl/Cmd/Alt 併用時はブラウザ/OS 標準のショートカットと衝突しうるため常に無視する(null)
 * - w/m/d・1/3 は isViewAllowedForWidth で許容されない view には解決しない(狭幅に無い
 *   'week' や広幅に無い 'day3'/'day1' を押しても無視する、toolbar のボタン構成と揃える)
 * - 入力中かどうか・オーバーレイが開いているかどうかの判定はこの関数の外(呼び出し側)で行う
 */
export function resolveShortcut(e: KeyLike, isNarrow: boolean): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  switch (e.key) {
    case 'ArrowLeft':
      return { kind: 'prev' }
    case 'ArrowRight':
      return { kind: 'next' }
    case 't':
    case 'T':
      return { kind: 'today' }
    case 'w':
    case 'W':
      return switchViewIfAllowed('week', isNarrow)
    case 'm':
    case 'M':
      return switchViewIfAllowed('month', isNarrow)
    case 'd':
    case 'D':
      return switchViewIfAllowed('day3', isNarrow)
    case '1':
      return switchViewIfAllowed('day1', isNarrow)
    case '3':
      return switchViewIfAllowed('day3', isNarrow)
    case 'n':
    case 'N':
      return { kind: 'newEvent' }
    case '?':
      return { kind: 'toggleHelp' }
    case 'Escape':
      return { kind: 'escape' }
    default:
      return null
  }
}
