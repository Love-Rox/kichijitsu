import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vite-plus/test";
import { isDemoSeriesId, isDemoSingleOccurrenceId } from "../db/database";
import { instanceId } from "./series";
import { generateDemoSeedData, generateDummyAllDayOccurrences } from "./dummy";

/**
 * `?demo=1` のデモデータ (model/dummy.ts) の性質のテスト。
 *
 * ここで固めたいのは見た目ではなく2つの約束:
 *
 *  1. **生成物すべてが cleanupDemoData (db/database.ts) の掃除対象になること。**
 *     デモの残骸が実データ環境に残らないことが cleanupDemoData の存在理由なので、
 *     デモデータを1種類足したときに「掃除対象の id 規則から漏れる」ことが起きないよう、
 *     生成物全件に掃除の述語を当てる(目視レビューに頼らない)。
 *  2. **同じ引数なら常に同じデータになること。**(起動のたびに違うデータが出ると
 *     「何度リロードしても同じ見え方」を目視で確かめられなくなる)
 */

const TZ = "Asia/Tokyo";
const BASE_DATE = Temporal.PlainDate.from("2026-07-30");
/** リマインダーのダミーだけが使う「いま」(2026-07-30T14:00+09:00)。決定性のため固定値を渡す */
const NOW_MS = Date.UTC(2026, 6, 30, 5, 0, 0);

describe("generateDemoSeedData", () => {
  it("series/override/occurrence のすべてが cleanupDemoData の id 規則に当てはまる", () => {
    const { series, overrides, occurrences } = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    expect(series.length).toBeGreaterThan(0);
    expect(overrides.length).toBeGreaterThan(0);
    expect(occurrences.length).toBeGreaterThan(0);

    // シリーズ: id が "series-" 始まり = cleanupDemoData が series ごと消せる
    for (const s of series) {
      expect(isDemoSeriesId(s.id), `series id: ${s.id}`).toBe(true);
    }
    // 単発 occurrence: id が "dummy-" 始まり = 親シリーズが無くても id だけで消せる
    for (const o of occurrences) {
      expect(isDemoSingleOccurrenceId(o.id), `occurrence id: ${o.id}`).toBe(true);
      // 単発なので seriesId は持たない(持つなら展開結果と混ざっている)
      expect(o.seriesId, `occurrence seriesId: ${o.id}`).toBeNull();
    }
    // override: 掃除はぶら下がっている seriesId で判定するので、そちらを検査する
    for (const ov of overrides) {
      expect(isDemoSeriesId(ov.seriesId), `override seriesId: ${ov.seriesId}`).toBe(true);
    }
  });

  it("展開結果 (シリーズ由来の occurrence) の id も掃除対象の規則に当てはまる", () => {
    // 展開は expansion/ が行うが、その id は `${seriesId}:${originalStartMs}` と決まっている。
    // cleanupDemoData は「現存する demo series の seriesId」だけでなく id 前方一致でも
    // 拾えるようにしてあるので、その前提(id が "series-" 始まりになること)を確かめる
    const { series } = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    for (const s of series) {
      expect(isDemoSeriesId(instanceId(s.id, 0))).toBe(true);
    }
  });

  it("同じ baseDate/timeZone なら常に同じデータを返す(ランダム性はシード固定)", () => {
    const a = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    const b = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    expect(b).toEqual(a);
  });

  it("id が重複しない(投入し直しても件数が揺れないことの前提)", () => {
    const { series, overrides, occurrences } = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    for (const list of [series, overrides, occurrences]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("リマインダーの確かめたい形が一通り揃っている(2026-07-31)", () => {
    // デモは「通知が実際に飛ぶか」を実ブラウザで見るための唯一の足場なので、確かめたい形が
    // 1つでも欠けると、その分岐は実機で一度も踏まれないまま出ていくことになる。
    // 形の一覧は generateDummyReminderOccurrences のコメントと対で維持すること。
    const { occurrences } = generateDemoSeedData(BASE_DATE, TZ, NOW_MS);
    const byId = new Map(occurrences.map((o) => [o.id, o]));

    expect(byId.get("dummy-reminder-basic")?.reminders).toEqual({ minutes: [10] });
    // 1つの予定に複数 (= それぞれの時刻で別々に通知が出る)
    expect(byId.get("dummy-reminder-multi")?.reminders).toEqual({ minutes: [10, 30] });
    // カレンダー既定に委ねる形 (分数が予定側に無い)
    expect(byId.get("dummy-reminder-default")?.reminders).toEqual({ useDefault: true });
    // リマインダーなし = 空配列。**キーが無いのとは別の意味**
    expect(byId.get("dummy-reminder-none")?.reminders).toEqual({ minutes: [] });
    // 上限 (1日) を超える分数 ―― 落とされて通知が出ないことを実機で見るためのもの
    expect(byId.get("dummy-reminder-too-early")?.reminders).toEqual({ minutes: [10080] });
    // 世代7のバックフィル前の予定 = キー自体が無い
    expect(byId.get("dummy-reminder-unsynced")).not.toHaveProperty("reminders");
  });
});

describe("generateDummyAllDayOccurrences", () => {
  it("IndexedDB に載せない分も id は掃除規則に揃えてある(将来永続化しても残骸にならないよう)", () => {
    // 現状は allDayStore へメモリ上でのみ load する (db/bootstrap.ts) ため掃除の必要が無いが、
    // id 規則だけは他のデモデータと揃えておく ―― 万一永続化する変更が入っても、
    // cleanupDemoData の対象から外れないようにするため
    for (const o of generateDummyAllDayOccurrences(BASE_DATE)) {
      expect(isDemoSingleOccurrenceId(o.id), `all-day id: ${o.id}`).toBe(true);
    }
  });
});

/**
 * デモ id の判定が**実データを巻き込まない**ことの確認 (2026-07-31)。
 * ゲスト編集の確認用に `g:` 形式のデモ id を足したので、実 Google データ
 * (accountId は UUID) が掃除対象に入らないことを明示的に押さえておく。
 */
describe("isDemoSingleOccurrenceId は実データを巻き込まない", () => {
  it("実 Google 由来の occurrence id は掃除対象にならない", () => {
    expect(
      isDemoSingleOccurrenceId("g:3f2b1c8e-0a11-4f77-9d0a-2b6c1e5f9a33:primary:abc123"),
    ).toBe(false);
  });

  it("デモ専用アカウントの id だけを拾う", () => {
    expect(isDemoSingleOccurrenceId("g:demo-account:demo-calendar:mine-with-guests")).toBe(true);
  });
});
