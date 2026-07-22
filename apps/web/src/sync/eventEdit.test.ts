import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Temporal } from "@js-temporal/polyfill";
import type { AllDayOccurrence, Occurrence } from "../model/types";
import {
  applyDraftToAllDayOccurrence,
  applyDraftToOccurrence,
  buildEventEditPatchRequest,
  dateValueToExclusiveEndMs,
  dateValueToMs,
  datetimeLocalValueToMs,
  draftFromAllDayOccurrence,
  draftFromOccurrence,
  isEditableEventSubject,
  msExclusiveToDateValue,
  msToDateValue,
  msToDatetimeLocalValue,
  validateEventEditDraft,
  type EventEditDraft,
} from "./eventEdit";

const TZ = "Asia/Tokyo";

function zms(iso: string, timeZone: string = TZ): number {
  return Temporal.PlainDateTime.from(iso).toZonedDateTime(timeZone).epochMilliseconds;
}

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

function baseAllDay(overrides: Partial<AllDayOccurrence> = {}): AllDayOccurrence {
  return {
    id: "g:acc-1:cal-1:evt-2",
    seriesId: null,
    title: "All Day Event",
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    color: "#3b82f6",
    source: "google",
    accountId: "acc-1",
    calendarId: "cal-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("draftFromOccurrence", () => {
  it("時刻予定から isAllDay:false の draft を組み立てる", () => {
    const occ = baseOccurrence({ location: "会議室A", description: "議題" });
    expect(draftFromOccurrence(occ)).toEqual({
      title: "Test Event",
      location: "会議室A",
      description: "議題",
      isAllDay: false,
      startMs: occ.startMs,
      endMs: occ.endMs,
    });
  });

  it("location/description 未設定は空文字にする", () => {
    const occ = baseOccurrence();
    const draft = draftFromOccurrence(occ);
    expect(draft.location).toBe("");
    expect(draft.description).toBe("");
  });
});

describe("draftFromAllDayOccurrence", () => {
  it("単日の終日予定: endMs は翌日のローカル 0:00 (排他的)", () => {
    const occ = baseAllDay({ startDate: "2026-07-20", endDate: "2026-07-20" });
    const draft = draftFromAllDayOccurrence(occ, TZ);
    expect(draft.isAllDay).toBe(true);
    expect(draft.startMs).toBe(zms("2026-07-20T00:00"));
    expect(draft.endMs).toBe(zms("2026-07-21T00:00"));
  });

  it("複数日にまたがる終日予定: endMs は endDate+1日のローカル 0:00", () => {
    const occ = baseAllDay({ startDate: "2026-07-20", endDate: "2026-07-22" });
    const draft = draftFromAllDayOccurrence(occ, TZ);
    expect(draft.startMs).toBe(zms("2026-07-20T00:00"));
    expect(draft.endMs).toBe(zms("2026-07-23T00:00"));
  });
});

describe("validateEventEditDraft", () => {
  function draft(overrides: Partial<EventEditDraft> = {}): EventEditDraft {
    return {
      title: "Test",
      location: "",
      description: "",
      isAllDay: false,
      startMs: zms("2026-07-20T10:00"),
      endMs: zms("2026-07-20T11:00"),
      ...overrides,
    };
  }

  it("正常な draft はエラー無し (null)", () => {
    expect(validateEventEditDraft(draft())).toBeNull();
  });

  it("タイトルが空(または空白のみ)ならエラー", () => {
    expect(validateEventEditDraft(draft({ title: "" }))).toBe("タイトルを入力してください");
    expect(validateEventEditDraft(draft({ title: "   " }))).toBe("タイトルを入力してください");
  });

  it("終了が開始以前ならエラー", () => {
    const startMs = zms("2026-07-20T10:00");
    expect(validateEventEditDraft(draft({ startMs, endMs: startMs }))).toBe(
      "終了日時は開始日時より後にしてください",
    );
    expect(validateEventEditDraft(draft({ startMs, endMs: startMs - 1000 }))).toBe(
      "終了日時は開始日時より後にしてください",
    );
  });
});

describe("isEditableEventSubject", () => {
  it("source==='google' かつ mirror でも Busy でもなければ編集可", () => {
    expect(isEditableEventSubject({ source: "google", title: "普通の予定" })).toBe(true);
  });

  it("source !== 'google' なら編集不可", () => {
    expect(isEditableEventSubject({ source: "local", title: "普通の予定" })).toBe(false);
  });

  it("isMirror な予定は編集不可", () => {
    expect(isEditableEventSubject({ source: "google", title: "予定あり", isMirror: true })).toBe(
      false,
    );
  });

  it("Busy/「予定あり」プレースホルダは編集不可", () => {
    expect(isEditableEventSubject({ source: "google", title: "Busy" })).toBe(false);
    expect(isEditableEventSubject({ source: "google", title: "予定あり" })).toBe(false);
  });
});

describe("buildEventEditPatchRequest", () => {
  const draft: EventEditDraft = {
    title: "編集後タイトル",
    location: "新しい場所",
    description: "新しい説明",
    isAllDay: false,
    startMs: zms("2026-07-20T14:00"),
    endMs: zms("2026-07-20T15:00"),
  };

  it("単発の google occurrence から EventPatchRequest を組み立てる(summary/location/description/isAllDay を含む)", () => {
    const occ = baseOccurrence();
    expect(buildEventEditPatchRequest(occ, draft, TZ)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      eventId: "evt-1",
      startMs: draft.startMs,
      endMs: draft.endMs,
      timeZone: TZ,
      summary: "編集後タイトル",
      location: "新しい場所",
      description: "新しい説明",
      isAllDay: false,
    });
  });

  it("空文字の location/description はクリアとしてそのまま送る", () => {
    const occ = baseOccurrence();
    const req = buildEventEditPatchRequest(occ, { ...draft, location: "", description: "" }, TZ);
    expect(req?.location).toBe("");
    expect(req?.description).toBe("");
  });

  it("isAllDay:true の draft は isAllDay:true を送る", () => {
    const occ = baseOccurrence();
    const req = buildEventEditPatchRequest(occ, { ...draft, isAllDay: true }, TZ);
    expect(req?.isAllDay).toBe(true);
  });

  it("シリーズ由来の occurrence はインスタンス ID を組み立てる", () => {
    const originalStartMs = zms("2026-07-20T10:00");
    const occ = baseOccurrence({
      id: `g:acc-1:cal-1:series-evt:${originalStartMs}`,
      seriesId: "g:acc-1:cal-1:series-evt",
      originalStartMs,
    });
    const req = buildEventEditPatchRequest(occ, draft, TZ);
    expect(req?.eventId).toBe("series-evt_20260720T010000Z");
  });

  it("AllDayOccurrence でも組み立てられる(originalStartMs 概念が無いので常に生 eventId)", () => {
    const occ = baseAllDay();
    const req = buildEventEditPatchRequest(occ, draft, TZ);
    expect(req?.eventId).toBe("evt-2");
  });

  it('source !== "google" なら null', () => {
    const occ = baseOccurrence({ source: "local" });
    expect(buildEventEditPatchRequest(occ, draft, TZ)).toBeNull();
  });

  it("accountId または calendarId が欠けていれば null", () => {
    const occ = baseOccurrence({ accountId: undefined });
    expect(buildEventEditPatchRequest(occ, draft, TZ)).toBeNull();
  });

  it("id のパースに失敗したら null (throw しない)", () => {
    const occ = baseOccurrence({ id: "not-a-google-id" });
    expect(buildEventEditPatchRequest(occ, draft, TZ)).toBeNull();
  });
});

describe("applyDraftToOccurrence", () => {
  it("時刻予定 → 時刻予定: 編集項目を反映しつつ他フィールドは保持する", () => {
    const occ = baseOccurrence({
      iCalUID: "ical-1",
      isOrganizer: true,
      responseStatus: "accepted",
    });
    const draft: EventEditDraft = {
      title: "新タイトル",
      location: "新場所",
      description: "新説明",
      isAllDay: false,
      startMs: zms("2026-07-20T14:00"),
      endMs: zms("2026-07-20T15:00"),
    };
    const result = applyDraftToOccurrence(occ, draft);
    expect(result).toEqual({
      ...occ,
      title: "新タイトル",
      location: "新場所",
      description: "新説明",
      startMs: draft.startMs,
      endMs: draft.endMs,
    });
  });

  it("空文字の location/description は undefined にする(ローカル表示の falsy 判定と揃える)", () => {
    const occ = baseOccurrence({ location: "元の場所" });
    const draft: EventEditDraft = {
      title: "T",
      location: "",
      description: "",
      isAllDay: false,
      startMs: occ.startMs,
      endMs: occ.endMs,
    };
    const result = applyDraftToOccurrence(occ, draft);
    expect(result.location).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("終日予定 → 時刻予定へ変換するとき、seriesId は null のまま id はそのまま引き継ぐ", () => {
    const allDay = baseAllDay();
    const draft: EventEditDraft = {
      title: "時刻予定に変換",
      location: "",
      description: "",
      isAllDay: false,
      startMs: zms("2026-07-20T09:00"),
      endMs: zms("2026-07-20T10:00"),
    };
    const result = applyDraftToOccurrence(allDay, draft);
    expect(result.id).toBe(allDay.id);
    expect(result.seriesId).toBeNull();
    expect(result.startMs).toBe(draft.startMs);
    expect(result.endMs).toBe(draft.endMs);
  });
});

describe("applyDraftToAllDayOccurrence", () => {
  it("時刻予定 → 終日予定へ変換するとき、draft.endMs (排他的) から inclusive な endDate を導出する", () => {
    const occ = baseOccurrence();
    const draft: EventEditDraft = {
      title: "終日に変換",
      location: "",
      description: "",
      isAllDay: true,
      startMs: zms("2026-07-20T00:00"),
      endMs: zms("2026-07-23T00:00"), // 7/20〜7/22 の3日間 (endDate inclusive=7/22)
    };
    const result = applyDraftToAllDayOccurrence(occ, draft, TZ);
    expect(result.id).toBe(occ.id);
    expect(result.seriesId).toBeNull();
    expect(result.startDate).toBe("2026-07-20");
    expect(result.endDate).toBe("2026-07-22");
  });

  it("終日予定 → 終日予定: 他フィールドを保持しつつ日付を更新する", () => {
    const allDay = baseAllDay({ isOrganizer: true, responseStatus: "tentative" });
    const draft: EventEditDraft = {
      title: "更新後",
      location: "場所",
      description: "説明",
      isAllDay: true,
      startMs: zms("2026-07-21T00:00"),
      endMs: zms("2026-07-22T00:00"),
    };
    const result = applyDraftToAllDayOccurrence(allDay, draft, TZ);
    expect(result.startDate).toBe("2026-07-21");
    expect(result.endDate).toBe("2026-07-21");
    expect(result.isOrganizer).toBe(true);
    expect(result.responseStatus).toBe("tentative");
  });
});

describe("<input> value ⇔ epoch ms 変換", () => {
  it("msToDatetimeLocalValue / datetimeLocalValueToMs は往復する", () => {
    const ms = zms("2026-07-20T10:05");
    const value = msToDatetimeLocalValue(ms, TZ);
    expect(value).toBe("2026-07-20T10:05");
    expect(datetimeLocalValueToMs(value, TZ)).toBe(ms);
  });

  it("msToDateValue / dateValueToMs は往復する(ローカル 0:00)", () => {
    const ms = zms("2026-07-20T00:00");
    const value = msToDateValue(ms, TZ);
    expect(value).toBe("2026-07-20");
    expect(dateValueToMs(value, TZ)).toBe(ms);
  });

  it("msExclusiveToDateValue / dateValueToExclusiveEndMs は往復する(1日前倒し⇔翌日0時)", () => {
    const exclusiveMs = zms("2026-07-23T00:00");
    const inclusiveValue = msExclusiveToDateValue(exclusiveMs, TZ);
    expect(inclusiveValue).toBe("2026-07-22");
    expect(dateValueToExclusiveEndMs(inclusiveValue, TZ)).toBe(exclusiveMs);
  });
});
