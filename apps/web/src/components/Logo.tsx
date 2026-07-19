import './Logo.css'

/**
 * kichijitsu ロゴ。ジオメトリ・トークンの正は /brand/ (変更禁止)。
 * ここは brand/mark-week.svg と同一の座標をインライン SVG として複製したもの。
 *
 * コンセプト「枡の週」: 7つの枡=1週間、5番目(金)だけ朱の枡が押印のように傾いて載る。
 * 色は fill を直接持たず CSS クラス経由 (.logo-cell / .logo-cell--kichi、実体は
 * Logo.css の --logo-usuzumi / --logo-aka カスタムプロパティ) にしてある。
 * アプリ本体はまだライト固定なのでダーク値は未適用 (Logo.css 側にコメントで
 * 値を残してある) — ダークテーマ実装時はそちらに prefers-color-scheme を足すだけでよい。
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 56"
      className={className ? `logo-mark ${className}` : 'logo-mark'}
      role="img"
      aria-label="kichijitsu"
    >
      <g className="logo-cell">
        <rect x="14" y="22.5" width="11" height="11" rx="3" />
        <rect x="40" y="22.5" width="11" height="11" rx="3" />
        <rect x="66" y="22.5" width="11" height="11" rx="3" />
        <rect x="92" y="22.5" width="11" height="11" rx="3" />
        <rect x="144" y="22.5" width="11" height="11" rx="3" />
        <rect x="170" y="22.5" width="11" height="11" rx="3" />
      </g>
      <rect
        className="logo-cell--kichi"
        x="116.5"
        y="21"
        width="14"
        height="14"
        rx="3.5"
        transform="rotate(-8 123.5 28)"
      />
    </svg>
  )
}

interface LogoWordmarkProps {
  className?: string
}

/**
 * 「kichijitsu」の文字組み。署名ディテールとして j の点(tittle)を傾いた朱の枡に置き換える。
 *
 * tittle 実装方式: U+0237 (dotless j, "ȷ") を採用。
 * Chrome DevTools MCP で実機確認 (このツールバーが使う system-ui フォント、
 * macOS Chrome) した結果、tofu 化はせず通常の "j" と同じ字送りで描画された
 * ため、フォールバック案(通常の j を生成り色矩形でマスクする方式)は不要だった。
 * 枡は絶対配置の <span class="logo-wordmark-masu"> を重ねているだけで、
 * dotless j 自体はネイティブの点を持たないので二重に点が出ることもない。
 *
 * ブランドルール改定 (2026-07-19, brand/README.md): j の枡は常に朱。以前は
 * マークと組むロックアップ時のみ墨色にする `accent` prop があったが、ユーザーの
 * 指摘で「ロゴ領域内は j の枡とマークの朱で1つのアクセントとみなす」に変更され、
 * このコンポーネントは常時朱で固定になった(呼び出し側の分岐は不要)。
 */
export function LogoWordmark({ className }: LogoWordmarkProps) {
  const classes = ['logo-wordmark', className].filter(Boolean).join(' ')

  return (
    <span className={classes} aria-label="kichijitsu">
      <span aria-hidden="true">kichi</span>
      <span className="logo-wordmark-j" aria-hidden="true">
        {'ȷ' /* dotless j (U+0237) */}
        <span className="logo-wordmark-masu" />
      </span>
      <span aria-hidden="true">itsu</span>
    </span>
  )
}
