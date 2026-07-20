import { useRef, useState } from "react";
import type { TimeEntry } from "../model/types";
import { entryDurationMs, formatDurationHm } from "../sync/timeTracking";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import "./RunningTimersIndicator.css";

export interface RunningTimersIndicatorProps {
  /** 走行中(endMs===null)の全エントリ。0件ならこのコンポーネントは何も描画しない */
  runningEntries: TimeEntry[];
  /** 経過時間の計算に使う現在時刻(App.tsx が1秒 tick で更新する)。走行中が無ければ更新は止まる */
  nowMs: number;
  /** 個別の ⏹ から呼ばれる。対象 linkedItemId のタイマーだけを止める */
  onStop: (linkedItemId: string) => void;
}

/**
 * ヘッダーの走行中タイマー インジケーター(docs/github-integration.md「時間計測」増分2、
 * 2026-07-20)。単一走行の制約が無い(複数 item を同時併走できる)ため、常に「⏱ N」の
 * バッジで件数を示し、クリックで展開する一覧に各 item の経過 + 個別 ⏹ を並べる
 * (BlockRulesOverlay 等と同じ「App が開閉制御せず自身で開閉を持つポップオーバー」構成)。
 */
export function RunningTimersIndicator({
  runningEntries,
  nowMs,
  onStop,
}: RunningTimersIndicatorProps) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(open, cardRef, () => setOpen(false));

  if (runningEntries.length === 0) return null;

  return (
    <div className="running-timers" ref={cardRef}>
      <button
        type="button"
        className="running-timers-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`計測中のタイマー ${runningEntries.length}件`}
        title="計測中のタイマー"
      >
        <span className="running-timers-pulse" aria-hidden="true" />
        <span aria-hidden="true">⏱ {runningEntries.length}</span>
      </button>
      {open && (
        <div className="running-timers-panel" role="dialog" aria-label="計測中のタイマー一覧">
          <ul className="running-timers-list">
            {runningEntries.map((entry) => (
              <li className="running-timers-item" key={entry.id}>
                <a
                  className="running-timers-item-label"
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${entry.repo} #${entry.number} ${entry.title}`}
                >
                  {entry.repo} #{entry.number} {entry.title}
                </a>
                <span className="running-timers-item-elapsed">
                  {formatDurationHm(entryDurationMs(entry, nowMs))}
                </span>
                <button
                  type="button"
                  className="running-timers-item-stop"
                  onClick={() => onStop(entry.linkedItemId)}
                  aria-label={`${entry.repo} #${entry.number} のタイマーを停止`}
                  title="停止"
                >
                  ⏹
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
