import {
  clampHourHeight,
  HOUR_HEIGHT_PRESETS,
  HOUR_HEIGHT_STEP,
  matchHourHeightPreset,
  MAX_HOUR_HEIGHT,
  MIN_HOUR_HEIGHT,
} from "../layout/gridMetrics";
import { ZoomInIcon, ZoomOutIcon } from "./icons";
import "./HourHeightControl.css";

interface HourHeightControlProps {
  /** 現在の1時間あたり px(App.tsx の state) */
  hourHeight: number;
  onChange: (next: number) => void;
  /**
   * 狭幅(モバイル)用の省スペース表示。プリセットのセレクトを畳み、虫眼鏡ボタンと現在値(数値)
   * だけを出す ―― ツールバーは狭幅で1段に収める制約があり(App.css の @media 参照)、
   * セレクトを置く余地が無いため。プリセット相当の高さは 8px 刻みの微調整でも到達できる
   * (32/48/72 はいずれも8の倍数)。
   */
  compact?: boolean;
}

/** 微調整でプリセットから外れているときにセレクトへ出す値(option の value に使う番兵) */
const CUSTOM_VALUE = "custom";

/**
 * 時間軸ズーム(2026-07-25、ユーザー要望)のツールバーコントロール。
 * 構成は「虫眼鏡−|プリセットのセレクト|虫眼鏡+」の3点 ―― プリセットは当初3つのボタンを並べて
 * いたが幅を取りすぎるためセレクトボックス1つに畳んだ(ユーザー要望)。微調整(8px 刻み)は
 * 虫眼鏡アイコンのボタンで、⌘/Ctrl+ホイールでのズームは WeekGrid 側が担当する。いずれも同じ
 * App の state を書き換えるので表示は常に一致する。
 *
 * 微調整でプリセットから外れた値になったときは、セレクトに「64px」のような現在値の option を
 * 一時的に足してそれを選択状態にする(プリセット名を偽って見せない/px 値を別の場所に併記して
 * 幅を食わない、の両立)。
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
        <ZoomOutIcon width={14} height={14} />
      </button>
      {compact ? (
        // 狭幅ではセレクトを置く幅が無いので現在値のみ(単位は省略して桁を稼ぐ)
        <span className="hour-zoom-value">{hourHeight}</span>
      ) : (
        <select
          className="hour-zoom-select"
          value={activePreset ?? CUSTOM_VALUE}
          aria-label="時間軸の高さのプリセット"
          onChange={(e) => {
            const preset = HOUR_HEIGHT_PRESETS.find((p) => p.id === e.target.value);
            // CUSTOM_VALUE(現在値の option)が選ばれた場合は何も変えない
            if (preset) onChange(preset.px);
          }}
        >
          {HOUR_HEIGHT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          {activePreset === null && <option value={CUSTOM_VALUE}>{hourHeight}px</option>}
        </select>
      )}
      <button
        type="button"
        className="hour-zoom-step"
        onClick={() => onChange(clampHourHeight(hourHeight + HOUR_HEIGHT_STEP))}
        disabled={atMax}
        aria-label="時間軸を広げる"
        title={`広げる (+${HOUR_HEIGHT_STEP}px)`}
      >
        <ZoomInIcon width={14} height={14} />
      </button>
    </div>
  );
}
