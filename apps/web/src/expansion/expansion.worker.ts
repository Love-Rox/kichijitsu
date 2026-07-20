import type { Occurrence } from "../model/types";
import type { EventSeries, InstanceOverride } from "../model/series";
import { expandSeries } from "./expandSeries";

/**
 * 純計算 Worker。IndexedDB や DOM には一切触れず、series+overrides を
 * occurrence 配列に展開して返すだけ。メインスレッド (ensureExpanded) が
 * 読み書きと状態管理を担う。
 */

export interface ExpansionRequest {
  requestId: number;
  series: EventSeries[];
  overrides: InstanceOverride[];
  fromMs: number;
  toMs: number;
}

export interface ExpansionResponse {
  requestId: number;
  occurrences: Occurrence[];
}

self.addEventListener("message", (event: MessageEvent<ExpansionRequest>) => {
  const { requestId, series, overrides, fromMs, toMs } = event.data;

  const overridesBySeriesId = new Map<string, InstanceOverride[]>();
  for (const ov of overrides) {
    const list = overridesBySeriesId.get(ov.seriesId);
    if (list) {
      list.push(ov);
    } else {
      overridesBySeriesId.set(ov.seriesId, [ov]);
    }
  }

  const occurrences: Occurrence[] = [];
  for (const s of series) {
    try {
      const expanded = expandSeries({
        series: s,
        overrides: overridesBySeriesId.get(s.id) ?? [],
        windowStartMs: fromMs,
        windowEndMs: toMs,
      });
      occurrences.push(...expanded);
    } catch (err) {
      // 1 series の失敗で他を巻き込まない
      console.error(`expansion.worker: failed to expand series "${s.id}"`, err);
    }
  }

  const response: ExpansionResponse = { requestId, occurrences };
  self.postMessage(response);
});
