import { useState } from "react";
import type { ReactNode } from "react";

/**
 * GitHub 情報ペイン内のセクション用アコーディオン。2026-07-25 のファイル分割(リファクタ
 * フェーズ1b)で GitHubPane.tsx から切り出した。
 *
 * GitHubPane.tsx に残さず独立モジュールにしたのは循環 import を避けるため ―― 分割後の
 * WorkQueueSection.tsx はこの PaneSection を使う一方、GitHubPane.tsx は WorkQueueSection を
 * 使うので、PaneSection を GitHubPane.tsx に置くと相互 import になる(layout/gridMetrics.ts が
 * 「WeekGrid と EventBlock の両方から参照するため循環を避けて独立させた」のと同じ理由)。
 *
 * CSS(.github-pane-section*)は GitHubPane.css にあり、その import は GitHubPane.tsx の1箇所に
 * 集約している(DayColumn/EventBlock が WeekGrid.css を共有しているのと同じ流儀 ―― このペインの
 * 部品は必ず GitHubPane 配下でマウントされるため)。
 */
export interface PaneSectionProps {
  title: string;
  /** 初期表示で開いておくか。開閉はローカル state のみ(永続化しない) */
  defaultOpen: boolean;
  /** 見出しに添える補助情報(件数・合計時間など)。トグルボタンの中に入る */
  meta?: ReactNode;
  /**
   * 見出し行の右端に置くセクション固有のアクション(作業キューの更新ボタンなど)。トグル
   * ボタンの「外」に置く ―― button の入れ子は不正な HTML になるため。
   */
  action?: ReactNode;
  children: ReactNode;
}

/**
 * ペイン内セクションのアコーディオン(2026-07-25)。実績モーダル吸収でセクションが4つに増え、
 * 420px 幅に全部を常時展開すると縦に伸びすぎるため、見出しをトグルボタン化した。見出しは
 * <h3> が <button> を包む標準的なアコーディオンの形にしてある(button の中に見出し要素を
 * 置くと phrasing content 違反になるため逆にはできない)。aria-expanded で開閉を伝え、
 * focus-visible のアウトラインは他のペイン内ボタンと同じ朱。
 *
 * 折りたたみ中は children をアンマウントする(display:none ではない) ―― 実績履歴の issue
 * タイトル補完や手動記録フォームの repo 一覧取得のような「マウント時に走る取得」を、開いた
 * ときだけに限定するのが狙い。
 */
export function PaneSection({ title, defaultOpen, meta, action, children }: PaneSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="github-pane-section">
      <div className="github-pane-section-header">
        <h3 className="github-pane-section-heading">
          <button
            type="button"
            className="github-pane-section-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="github-pane-section-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="github-pane-section-title">{title}</span>
            {meta && <span className="github-pane-section-meta">{meta}</span>}
          </button>
        </h3>
        {action}
      </div>
      {open && <div className="github-pane-section-body">{children}</div>}
    </section>
  );
}
