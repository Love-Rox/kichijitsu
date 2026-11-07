import { getMeta, setMeta } from "./localDb";

/**
 * ウィジェットと Apple Watch(アプリ・コンプリケーション)に出す予定の絞り込み。この端末だけの設定。
 * 送る予定が共通なので、設定も共通。通知(開始の知らせ)や、アプリ内の表示には影響しない。
 */
export interface WidgetFilters {
  /** 不在(Google の「不在」)の予定を含める。 */
  outOfOffice: boolean;
  /** 勤務場所(自宅・オフィスなど)の予定を含める。 */
  workingLocation: boolean;
}

/** 既定: 従来の挙動のまま(不在は出さない、勤務場所は出す)。 */
export const DEFAULT_WIDGET_FILTERS: WidgetFilters = { outOfOffice: false, workingLocation: true };

const OOO_KEY = "widgetShowOutOfOffice";
const WL_KEY = "widgetShowWorkingLocation";

const read = (v: string | null, fallback: boolean) => (v === "1" ? true : v === "0" ? false : fallback);

export async function getWidgetFilters(): Promise<WidgetFilters> {
  const [ooo, wl] = await Promise.all([getMeta(OOO_KEY), getMeta(WL_KEY)]);
  return {
    outOfOffice: read(ooo, DEFAULT_WIDGET_FILTERS.outOfOffice),
    workingLocation: read(wl, DEFAULT_WIDGET_FILTERS.workingLocation),
  };
}

export async function saveWidgetFilters(f: WidgetFilters): Promise<void> {
  await setMeta(OOO_KEY, f.outOfOffice ? "1" : "0");
  await setMeta(WL_KEY, f.workingLocation ? "1" : "0");
}
