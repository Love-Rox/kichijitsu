import './KeyboardHelpOverlay.css'

interface ShortcutRow {
  keys: string[]
  label: string
}

const ROWS: ShortcutRow[] = [
  { keys: ['←', '→'], label: '前へ / 次へ' },
  { keys: ['t'], label: '今日' },
  { keys: ['w'], label: '週表示' },
  { keys: ['m'], label: '月表示' },
  { keys: ['d', '3'], label: '3日表示' },
  { keys: ['1'], label: '1日表示' },
  { keys: ['n'], label: '新規予定' },
  { keys: ['?'], label: 'このヘルプ' },
  { keys: ['Esc'], label: '閉じる' },
]

interface KeyboardHelpOverlayProps {
  onClose: () => void
}

/**
 * キーボードショートカット一覧のヘルプオーバーレイ(フェーズ6)。'?' キーで
 * トグル表示する軽量なモーダル。開閉制御(トグル・Escape)は App.tsx の
 * グローバル keydown ハンドラが担い、このコンポーネントは常に「開いている」前提で
 * 描画するだけ(CalendarSettingsPanel と同じ役割分担)。背景クリックでも閉じられるようにする。
 */
export function KeyboardHelpOverlay({ onClose }: KeyboardHelpOverlayProps) {
  return (
    <div className="keyboard-help-backdrop" onClick={onClose}>
      <div
        className="keyboard-help-card"
        role="dialog"
        aria-label="キーボードショートカット"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="keyboard-help-header">
          <span className="keyboard-help-title">キーボードショートカット</span>
          <button type="button" className="keyboard-help-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
        </div>
        <ul className="keyboard-help-list">
          {ROWS.map((row) => (
            <li className="keyboard-help-row" key={row.label}>
              <span className="keyboard-help-keys">
                {row.keys.map((k, i) => (
                  <span key={i}>
                    {i > 0 && <span className="keyboard-help-key-sep">/</span>}
                    <kbd className="keyboard-help-kbd">{k}</kbd>
                  </span>
                ))}
              </span>
              <span className="keyboard-help-label">{row.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
