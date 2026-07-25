import {
  clampHourHeight,
  HOUR_HEIGHT_PRESETS,
  HOUR_HEIGHT_STEP,
  matchHourHeightPreset,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
} from "../layout/gridMetrics";
import "./HourHeightControl.css";

interface HourHeightControlProps {
  /** 現在の1時間あたり px(App.tsx の state) */
  hourHeight: number;
  onChange: (next: number) => void;
  /**
   * 狭幅(モバイル)用の省スペース表示。プリセットのセグメントは畳み、−/+ と現在値(数値)だけを出す
   * ―― ツールバーは狭幅で1段に収める制約があり(App.css の @media 参照)、プリセット3つを
   * 並べる余地が無いため。プリセット相当の高さは −/+ の8px刻みでも到達できる(32/48/72 はいずれも8の倍数)。
   */
  compact?: boolean;
}

/**
 * 時間軸ズーム(2026-07-25、ユーザー要望)のツールバーコントロール。
 * プリセット(コンパクト32px/標準48px/ゆったり72px)のワンクリックと、−/+ の 8px 刻み微調整
 * (24〜120px)を1つのグループにまとめる。⌘/Ctrl+ホイールでのズームは WeekGrid 側が担当し、
 * どちらも同じ App の state を書き換えるので表示は常に一致する。
 *
 * 現在値がプリセットと一致していればそのボタンをアクティブ表示にし、微調整で外れたら
 * 実 px 値を小さく表示する(ユーザー決定)。
 */
export function HourHeightControl({
  hourHeight,
  onChange,
  compact = false,
}: HourHeightControlProps) {
  const activePreset = matchHourHeightPreset(hourHeight);
  const atMin = hourHeight <= MIN_HOUR_HEIGHT;
  const atMax = hourHeight >= MAX_HOUR_HEIGHT;

  return (
    <div
      className="hour-zoom"
      role="group"
      aria-label={`時間軸の高さ (1時間 ${hourHeight}px)`}
      title={`時間軸の高さ: 1時間 ${hourHeight}px (⌘/Ctrl + ホイールでも変更できます)`}
    >
      <button
        type="button"
        className="hour-zoom-step"
        onClick={() => onChange(clampHourHeight(hourHeight - HOUR_HEIGHT_STEP))}
        disabled={atMin}
        aria-label="時間軸を縮める"
        title={`縮める (−${HOUR_HEIGHT_STEP}px)`}
      >
        −
      </button>
      {!compact &&
        HOUR_HEIGHT_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={activePreset === preset.id ? "hour-zoom-preset is-active" : "hour-zoom-preset"}
            aria-pressed={activePreset === preset.id}
            onClick={() => onChange(preset.px)}
            title={`${preset.label} (1時間 ${preset.px}px)`}
          >
            {preset.label}
          </button>
        ))}
      {/* プリセットと一致しない微調整中の値。狭幅ではプリセットを出さないので常に現在値を見せる */}
      {(compact || activePreset === null) && (
        <span className="hour-zoom-value">{compact ? hourHeight : `${hourHeight}px`}</span>
      )}
      <button
        type="button"
        className="hour-zoom-step"
        onClick={() => onChange(clampHourHeight(hourHeight + HOUR_HEIGHT_STEP))}
        disabled={atMax}
        aria-label="時間軸を広げる"
        title={`広げる (+${HOUR_HEIGHT_STEP}px)`}
      >
        ＋
      </button>
    </div>
  );
}
