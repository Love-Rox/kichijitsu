/**
 * 設定モーダルの「タイムゾーン」セクション(複数タイムゾーン、2026-11-07)。時刻軸の脇に並べる、
 * 別のタイムゾーンを、最大 2 つまで追加・削除する。保存ボタンは持たず、選んだ瞬間に保存と反映が済む
 * (テーマ設定と同じ流儀)。基準の表示は、これまでどおり端末のタイムゾーン。
 */
import { Temporal } from "@js-temporal/polyfill";
import { useMemo, useState } from "react";
import {
  MAX_SECONDARY_TIME_ZONES,
  timeZoneCity,
  timeZoneOffsetLabel,
} from "../../layout/secondaryTimeZones";
import {
  getSecondaryTimeZones,
  setSecondaryTimeZones,
  useSecondaryTimeZones,
} from "../../sync/secondaryTimeZonesPref";

/** 選べるタイムゾーンの一覧(ブラウザが知っているもの。古い環境では、主要な地域だけ) */
function allTimeZones(): string[] {
  try {
    const list = Intl.supportedValuesOf("timeZone");
    if (list.length > 0) return list;
  } catch {
    /* 古い環境 */
  }
  return [
    "Asia/Tokyo",
    "Asia/Seoul",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Pacific/Auckland",
    "Australia/Sydney",
    "UTC",
  ];
}

export function TimeZoneSection() {
  const primary = useMemo(() => Temporal.Now.timeZoneId(), []);
  const current = useSecondaryTimeZones(primary);
  const [pick, setPick] = useState("");
  const today = useMemo(() => Temporal.Now.plainDateISO(primary), [primary]);
  const options = useMemo(
    () => allTimeZones().filter((z) => z !== primary && !current.includes(z)),
    [primary, current],
  );
  const full = current.length >= MAX_SECONDARY_TIME_ZONES;

  const add = () => {
    if (!pick || full) return;
    setSecondaryTimeZones([...getSecondaryTimeZones(), pick]);
    setPick("");
  };

  return (
    <section className="settings-modal-section">
      <h3 className="settings-modal-section-title" id="settings-timezone-title">
        タイムゾーン
      </h3>
      <p className="settings-modal-section-desc">
        時刻軸の左に、別のタイムゾーンの時刻を並べます(最大 {MAX_SECONDARY_TIME_ZONES} つ)。
        予定の時刻は、これまでどおり、この端末のタイムゾーン({timeZoneCity(primary)})で表示されます。
      </p>

      {current.length > 0 && (
        <ul className="settings-modal-tz-list" aria-labelledby="settings-timezone-title">
          {current.map((tz) => (
            <li className="settings-modal-tz-item" key={tz}>
              <span className="settings-modal-tz-name">
                {timeZoneCity(tz)}
                <span className="settings-modal-tz-offset">{timeZoneOffsetLabel(tz, today)}</span>
              </span>
              <button
                type="button"
                className="settings-modal-tz-remove"
                onClick={() => setSecondaryTimeZones(getSecondaryTimeZones().filter((z) => z !== tz))}
                aria-label={`${timeZoneCity(tz)}を外す`}
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-modal-tz-add">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          disabled={full}
          aria-label="追加するタイムゾーン"
        >
          <option value="">{full ? "上限まで追加しています" : "タイムゾーンを選ぶ"}</option>
          {options.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}({timeZoneOffsetLabel(z, today)})
            </option>
          ))}
        </select>
        <button type="button" onClick={add} disabled={!pick || full}>
          追加
        </button>
      </div>
    </section>
  );
}
