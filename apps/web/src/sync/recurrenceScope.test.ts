import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { EventSeries } from "../model/series";
import type { Occurrence } from "../model/types";
import {
  applyScopeAllToSeries,
  availableRecurrenceScopes,
  buildScopedEventPatchRequest,
  canApplyScopeAll,
  DEFAULT_RECURRENCE_SCOPE,
  isSeriesInstance,
  resolveScopedPatchTarget,
  seriesDtstartMs,
  seriesShiftFor,
} from "./recurrenceScope";

const TZ = "Asia/Tokyo";

function zms(iso: string, timeZone = TZ): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

/** 毎週月・水 10:00-10:30 のシリーズ (dtstart は月曜) */
function baseSeries(overrides: Partial<EventSeries> = {}): EventSeries {
  return {
    id: "g:acc-1:cal-1:series-1",
    title: "定例",
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    dtstartIso: "2026-06-15T10:00",
    timeZone: TZ,
    durationMin: 30,
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
    exdatesMs: [],
    ...overrides,
  };
}

/** シリーズ由来の1回分 (7/20 月 10:00-10:30、override なし) */
const SERIES_SUBJECT = {
  id: "g:acc-1:cal-1:series-1:" + zms("2026-07-20T10:00"),
  seriesId: "g:acc-1:cal-1:series-1",
  originalStartMs: zms("2026-07-20T10:00"),
};

const OCCURRENCE_RANGE = {
  startMs: zms("2026-07-20T10:00"),
  endMs: zms("2026-07-20T10:30"),
};

describe("isSeriesInstance", () => {
  it("seriesId と originalStartMs が揃っていれば true", () => {
    expect(isSeriesInstance(SERIES_SUBJECT)).toBe(true);
  });

  it("単発予定 (seriesId=null) は false", () => {
    expect(isSeriesInstance({ id: "g:acc-1:cal-1:evt-1", seriesId: null })).toBe(false);
  });

  it("seriesId はあるが originalStartMs が無ければ false (どの回か特定できない)", () => {
    expect(isSeriesInstance({ id: "x", seriesId: "g:acc-1:cal-1:series-1" })).toBe(false);
  });

  it("originalStartMs=0 は有効な値として扱う (falsy だが未定義ではない)", () => {
    expect(isSeriesInstance({ id: "x", seriesId: "s", originalStartMs: 0 })).toBe(true);
  });
});

describe("seriesDtstartMs / seriesShiftFor", () => {
  it("dtstartIso をシリーズのタイムゾーンで epoch ms にする", () => {
    expect(seriesDtstartMs(baseSeries())).toBe(zms("2026-06-15T10:00"));
  });

  it("同じ壁時計でもタイムゾーンが違えば別の瞬間になる", () => {
    expect(seriesDtstartMs({ dtstartIso: "2026-06-15T10:00", timeZone: "UTC" })).toBe(
      zms("2026-06-15T10:00", "UTC"),
    );
  });

  it("開始・終了それぞれの差分を返す (長さの変更も表現できる)", () => {
    expect(
      seriesShiftFor(
        { startMs: 1_000, endMs: 2_000 },
        { startMs: 1_500, endMs: 3_000 },
      ),
    ).toEqual({ startDeltaMs: 500, endDeltaMs: 1_000 });
  });
});

describe("availableRecurrenceScopes — 繰り返しでない予定は問いかけない", () => {
  it("単発予定は空配列 (適用範囲の UI を一切出さない)", () => {
    expect(
      availableRecurrenceScopes({
        subject: { id: "g:acc-1:cal-1:evt-1", seriesId: null },
        series: baseSeries(),
        previous: OCCURRENCE_RANGE,
        next: OCCURRENCE_RANGE,
      }),
    ).toEqual([]);
  });

  it("seriesId があっても originalStartMs が無ければ空配列", () => {
    expect(
      availableRecurrenceScopes({
        subject: { id: "x", seriesId: "g:acc-1:cal-1:series-1" },
        series: baseSeries(),
      }),
    ).toEqual([]);
  });

  it("繰り返しの1回分で、時刻を動かさないなら「この予定のみ」と「すべて」", () => {
    expect(
      availableRecurrenceScopes({
        subject: SERIES_SUBJECT,
        series: baseSeries(),
        previous: OCCURRENCE_RANGE,
        next: OCCURRENCE_RANGE,
      }),
    ).toEqual(["this", "all"]);
  });

  it("series レコードが取れていなければ「この予定のみ」だけ (親の DTSTART が分からない)", () => {
    expect(
      availableRecurrenceScopes({
        subject: SERIES_SUBJECT,
        series: null,
        previous: OCCURRENCE_RANGE,
        next: OCCURRENCE_RANGE,
      }),
    ).toEqual(["this"]);
  });
});

describe("canApplyScopeAll — 親の DTSTART の日付が動くかどうか", () => {
  const series = baseSeries();

  it("同じ日の中での移動 (+1時間) は許す", () => {
    expect(
      canApplyScopeAll({
        subject: SERIES_SUBJECT,
        series,
        previous: OCCURRENCE_RANGE,
        next: { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") },
      }),
    ).toBe(true);
  });

  it("長さだけの変更 (開始は同じ) も許す", () => {
    expect(
      canApplyScopeAll({
        subject: SERIES_SUBJECT,
        series,
        previous: OCCURRENCE_RANGE,
        next: { startMs: zms("2026-07-20T10:00"), endMs: zms("2026-07-20T11:00") },
      }),
    ).toBe(true);
  });

  it("日をまたぐ移動 (月→水) は許さない (RRULE の BYDAY と食い違うため)", () => {
    expect(
      canApplyScopeAll({
        subject: SERIES_SUBJECT,
        series,
        previous: OCCURRENCE_RANGE,
        next: { startMs: zms("2026-07-22T10:00"), endMs: zms("2026-07-22T10:30") },
      }),
    ).toBe(false);
  });

  it("同じ日の中の移動に見えても、親の DTSTART が日をまたぐなら許さない", () => {
    // dtstart 23:30 のシリーズを +1 時間 → 親は翌日 0:30 になる
    const lateSeries = baseSeries({ dtstartIso: "2026-06-15T23:30" });
    expect(
      canApplyScopeAll({
        subject: SERIES_SUBJECT,
        series: lateSeries,
        previous: OCCURRENCE_RANGE,
        next: { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") },
      }),
    ).toBe(false);
  });

  it("判定はシリーズのタイムゾーンで行う (表示タイムゾーンではない)", () => {
    // UTC の 15:00 は JST では翌日 0:00。UTC 基準では日をまたがないので許す
    const utcSeries = baseSeries({ dtstartIso: "2026-06-15T09:00", timeZone: "UTC" });
    expect(
      canApplyScopeAll({
        subject: SERIES_SUBJECT,
        series: utcSeries,
        previous: OCCURRENCE_RANGE,
        next: { startMs: OCCURRENCE_RANGE.startMs + 6 * 3_600_000, endMs: OCCURRENCE_RANGE.endMs },
      }),
    ).toBe(true);
  });
});

describe("resolveScopedPatchTarget — 宛先の決定", () => {
  const series = baseSeries();

  it("既定の適用範囲は「この予定のみ」", () => {
    expect(DEFAULT_RECURRENCE_SCOPE).toBe("this");
  });

  it("単発予定は従来どおり occurrence の id から取った生の event id + 変更後の時刻", () => {
    const next = { startMs: 111, endMs: 222 };
    expect(
      resolveScopedPatchTarget({
        subject: { id: "g:acc-1:cal-1:evt-1", seriesId: null },
        scope: "this",
        next,
      }),
    ).toEqual({ eventId: "evt-1", startMs: 111, endMs: 222 });
  });

  it("「この予定のみ」はインスタンス id (親_originalStart の UTC basic) + 変更後の時刻", () => {
    const next = { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") };
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "this",
        series,
        previous: OCCURRENCE_RANGE,
        next,
      }),
    ).toEqual({
      // 2026-07-20T10:00 JST = 2026-07-20T01:00Z
      eventId: "series-1_20260720T010000Z",
      startMs: next.startMs,
      endMs: next.endMs,
    });
  });

  it("「すべて」は親の event id へ、親の DTSTART に差分を足した時刻で送る", () => {
    const next = { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") };
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series,
        previous: OCCURRENCE_RANGE,
        next,
      }),
    ).toEqual({
      eventId: "series-1",
      startMs: zms("2026-06-15T11:00"),
      endMs: zms("2026-06-15T11:30"),
    });
  });

  it("「すべて」で時刻を触っていないなら start/end を送らない (親の DTSTART を書き直さない)", () => {
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series,
        previous: OCCURRENCE_RANGE,
        next: OCCURRENCE_RANGE,
      }),
    ).toEqual({ eventId: "series-1" });
  });

  it("「すべて」の差分は、この回の override によるずれを巻き込まない", () => {
    // この回は override で 10:30 にずれている。そこから 11:00 へ動かした = +30分だけを写す
    const shifted = { startMs: zms("2026-07-20T10:30"), endMs: zms("2026-07-20T11:00") };
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series,
        previous: shifted,
        next: { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") },
      }),
    ).toEqual({
      eventId: "series-1",
      startMs: zms("2026-06-15T10:30"),
      endMs: zms("2026-06-15T11:00"),
    });
  });

  it("「すべて」で長さだけ変えたときは親の終了だけが動く", () => {
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series,
        previous: OCCURRENCE_RANGE,
        next: { startMs: OCCURRENCE_RANGE.startMs, endMs: zms("2026-07-20T11:00") },
      }),
    ).toEqual({
      eventId: "series-1",
      startMs: zms("2026-06-15T10:00"),
      endMs: zms("2026-06-15T11:00"),
    });
  });

  it("「すべて」が選べない移動 (日をまたぐ) では null", () => {
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series,
        previous: OCCURRENCE_RANGE,
        next: { startMs: zms("2026-07-22T10:00"), endMs: zms("2026-07-22T10:30") },
      }),
    ).toBeNull();
  });

  it("「すべて」で series が無ければ null", () => {
    expect(
      resolveScopedPatchTarget({
        subject: SERIES_SUBJECT,
        scope: "all",
        series: null,
        previous: OCCURRENCE_RANGE,
        next: OCCURRENCE_RANGE,
      }),
    ).toBeNull();
  });

  it("id の形が壊れていれば throw する (呼び出し側の try/catch で null に落ちる)", () => {
    expect(() =>
      resolveScopedPatchTarget({
        subject: { id: "not-a-google-id", seriesId: null },
        scope: "this",
        next: { startMs: 0, endMs: 1 },
      }),
    ).toThrow();
  });
});

describe("applyScopeAllToSeries — ローカルの series レコードの更新後の姿", () => {
  it("時刻の差分を dtstartIso と durationMin に写す", () => {
    const updated = applyScopeAllToSeries({
      series: baseSeries(),
      previous: OCCURRENCE_RANGE,
      next: { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T12:00") },
    });
    expect(updated.dtstartIso).toBe("2026-06-15T11:00");
    expect(updated.durationMin).toBe(60);
  });

  it("時刻を触っていなければ dtstartIso / durationMin は完全に据え置き", () => {
    const series = baseSeries();
    const updated = applyScopeAllToSeries({
      series,
      previous: OCCURRENCE_RANGE,
      next: OCCURRENCE_RANGE,
      fields: { title: "新しいタイトル" },
    });
    expect(updated.dtstartIso).toBe(series.dtstartIso);
    expect(updated.durationMin).toBe(series.durationMin);
    expect(updated.title).toBe("新しいタイトル");
  });

  it("場所・説明の空文字は「クリア」として undefined に落とす", () => {
    const updated = applyScopeAllToSeries({
      series: baseSeries({ location: "会議室A", description: "メモ" }),
      fields: { location: "", description: "" },
    });
    expect(updated.location).toBeUndefined();
    expect(updated.description).toBeUndefined();
  });

  it("RRULE・EXDATE・id には触らない (EXDATE を巻き添えで消さない)", () => {
    const series = baseSeries({ exdatesMs: [123, 456] });
    const updated = applyScopeAllToSeries({
      series,
      previous: OCCURRENCE_RANGE,
      next: { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") },
    });
    expect(updated.rrule).toBe(series.rrule);
    expect(updated.exdatesMs).toEqual([123, 456]);
    expect(updated.id).toBe(series.id);
  });

  it("元の series オブジェクトは破壊しない", () => {
    const series = baseSeries();
    applyScopeAllToSeries({ series, fields: { title: "別のタイトル" } });
    expect(series.title).toBe("定例");
  });
});

// ---- buildScopedEventPatchRequest ----
// ドラッグ確定と編集フォーム保存の**両方が通る唯一の入口**。とくに
// 「繰り返しでない予定は 2026-07-30 以前と1バイトも変わらない」をここで固定する。

function baseOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: "g:acc-1:cal-1:evt-1",
    seriesId: null,
    title: "Test Event",
    startMs: zms("2026-07-20T10:00"),
    endMs: zms("2026-07-20T11:00"),
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

/** シリーズ由来の1回分の Occurrence (7/20 月 10:00-10:30) */
function seriesOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return baseOccurrence({
    id: SERIES_SUBJECT.id,
    seriesId: SERIES_SUBJECT.seriesId,
    originalStartMs: SERIES_SUBJECT.originalStartMs,
    startMs: OCCURRENCE_RANGE.startMs,
    endMs: OCCURRENCE_RANGE.endMs,
    ...overrides,
  });
}

describe("buildScopedEventPatchRequest — 繰り返しでない予定 (従来どおり)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("単発の google occurrence は生の event id + 変更後の時刻", () => {
    const occ = baseOccurrence();
    expect(
      buildScopedEventPatchRequest({
        subject: occ,
        scope: "this",
        next: { startMs: occ.startMs, endMs: occ.endMs },
        timeZone: TZ,
      }),
    ).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      startMs: occ.startMs,
      endMs: occ.endMs,
      timeZone: TZ,
    });
  });

  it("単発予定は series を渡しても scope='all' を渡しても宛先が変わらない", () => {
    // UI は単発予定に適用範囲を出さない (availableRecurrenceScopes が空配列) が、
    // 万一 scope='all' で呼ばれても isSeriesInstance が false なので親には行かない
    const occ = baseOccurrence();
    const next = { startMs: occ.startMs, endMs: occ.endMs };
    expect(
      buildScopedEventPatchRequest({
        subject: occ,
        scope: "all",
        series: baseSeries(),
        previous: next,
        next,
        timeZone: TZ,
      }),
    ).toBeNull();
  });

  it("編集フォームの内容 (fields) をそのまま載せる", () => {
    const occ = baseOccurrence();
    const req = buildScopedEventPatchRequest({
      subject: occ,
      scope: "this",
      next: { startMs: occ.startMs, endMs: occ.endMs },
      timeZone: TZ,
      fields: { summary: "新題", location: "", description: "説明", isAllDay: false },
    });
    expect(req).toMatchObject({
      eventId: "evt-1",
      summary: "新題",
      location: "",
      description: "説明",
      isAllDay: false,
    });
  });

  it('source !== "google" なら null', () => {
    const occ = baseOccurrence({ source: "local" });
    expect(
      buildScopedEventPatchRequest({
        subject: occ,
        scope: "this",
        next: { startMs: occ.startMs, endMs: occ.endMs },
        timeZone: TZ,
      }),
    ).toBeNull();
  });

  it("id のパースに失敗したら null (console.error はするが throw しない)", () => {
    const occ = baseOccurrence({ id: "not-a-google-id" });
    expect(
      buildScopedEventPatchRequest({
        subject: occ,
        scope: "this",
        next: { startMs: occ.startMs, endMs: occ.endMs },
        timeZone: TZ,
      }),
    ).toBeNull();
  });
});

describe("buildScopedEventPatchRequest — 繰り返し予定", () => {
  it("「この予定のみ」はインスタンス ID へ (2026-07-30 以前と同じ)", () => {
    const next = { startMs: zms("2026-07-20T14:00"), endMs: zms("2026-07-20T15:00") };
    expect(
      buildScopedEventPatchRequest({
        subject: seriesOccurrence({ ...next }),
        scope: "this",
        series: baseSeries(),
        previous: OCCURRENCE_RANGE,
        next,
        timeZone: TZ,
      }),
    ).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "series-1_20260720T010000Z",
      startMs: next.startMs,
      endMs: next.endMs,
      timeZone: TZ,
    });
  });

  it("「すべて」は親の event id へ、DTSTART に差分を足した時刻で", () => {
    const next = { startMs: zms("2026-07-20T11:00"), endMs: zms("2026-07-20T11:30") };
    expect(
      buildScopedEventPatchRequest({
        subject: seriesOccurrence({ ...next }),
        scope: "all",
        series: baseSeries(),
        previous: OCCURRENCE_RANGE,
        next,
        timeZone: TZ,
      }),
    ).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "series-1",
      startMs: zms("2026-06-15T11:00"),
      endMs: zms("2026-06-15T11:30"),
      timeZone: TZ,
    });
  });

  it("「すべて」で内容だけを変えるときは startMs/endMs を送らない", () => {
    const req = buildScopedEventPatchRequest({
      subject: seriesOccurrence(),
      scope: "all",
      series: baseSeries(),
      previous: OCCURRENCE_RANGE,
      next: OCCURRENCE_RANGE,
      timeZone: TZ,
      fields: { summary: "新題" },
    });
    expect(req).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "series-1",
      startMs: undefined,
      endMs: undefined,
      timeZone: TZ,
      summary: "新題",
    });
  });

  it("「すべて」が選べない移動 (日をまたぐ) では null", () => {
    const next = { startMs: zms("2026-07-22T10:00"), endMs: zms("2026-07-22T10:30") };
    expect(
      buildScopedEventPatchRequest({
        subject: seriesOccurrence({ ...next }),
        scope: "all",
        series: baseSeries(),
        previous: OCCURRENCE_RANGE,
        next,
        timeZone: TZ,
      }),
    ).toBeNull();
  });
});
