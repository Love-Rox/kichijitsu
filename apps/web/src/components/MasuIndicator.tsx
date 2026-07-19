import './MasuIndicator.css'

interface MasuIndicatorProps {
  /** sm = ボタン内用(高さ約14px)、md = 標準(高さ約48px) */
  size?: 'sm' | 'md'
  className?: string
}

interface Cell {
  x: number
  /** brand/README.md: 枡の登場ずれ 130ms */
  delayMs: number
  kichi?: true
}

// ロゴ mark-week (brand/mark-week.svg, Logo.tsx の <LogoMark>) と同一ジオメトリ。
// 5番目(x=116.5)だけ朱の押印枡で、他の6枡は薄墨。
const CELLS: readonly Cell[] = [
  { x: 14, delayMs: 0 },
  { x: 40, delayMs: 130 },
  { x: 66, delayMs: 260 },
  { x: 92, delayMs: 390 },
  { x: 116.5, delayMs: 520, kichi: true },
  { x: 144, delayMs: 650 },
  { x: 170, delayMs: 780 },
]

/**
 * 枡インジケーター(brand/README.md「モーション」節)。同期中・展開中などの
 * ローディング表示で、ロゴがそのまま動く。1周1820ms、枡の登場ずれ130ms、
 * イージング cubic-bezier(.2,.7,.3,1)。5番目の朱の枡のみ押印オーバーシュート
 * (scale 1.45→1→1.06→1、常に rotate(-8deg))、他は scale .55→1 で静かに登場する。
 * `prefers-reduced-motion: reduce` では MasuIndicator.css 側で静止した完成形マークに切り替わる。
 */
export function MasuIndicator({ size = 'md', className }: MasuIndicatorProps) {
  const classes = ['masu-indicator', `masu-indicator--${size}`, className].filter(Boolean).join(' ')

  return (
    <svg viewBox="0 0 200 56" className={classes} role="img" aria-label="読み込み中">
      {CELLS.map((cell) =>
        cell.kichi ? (
          <rect
            key={cell.x}
            className="masu-indicator-cell masu-indicator-cell--kichi"
            style={{ animationDelay: `${cell.delayMs}ms` }}
            x={cell.x}
            y={21}
            width={14}
            height={14}
            rx={3.5}
          />
        ) : (
          <rect
            key={cell.x}
            className="masu-indicator-cell"
            style={{ animationDelay: `${cell.delayMs}ms` }}
            x={cell.x}
            y={22.5}
            width={11}
            height={11}
            rx={3}
          />
        ),
      )}
    </svg>
  )
}
