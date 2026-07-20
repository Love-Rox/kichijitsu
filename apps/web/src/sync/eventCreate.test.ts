import { describe, expect, it } from "vite-plus/test";
import {
  buildEventCreateRequest,
  buildPendingOccurrence,
  buildPendingOccurrenceId,
  finalizeCreatedOccurrence,
  resolveDefaultWriteTarget,
  type WriteTargetCandidate,
} from "./eventCreate";

describe("resolveDefaultWriteTarget", () => {
  it("候補が無ければ null", () => {
    expect(resolveDefaultWriteTarget([])).toBeNull();
  });

  it("primary がある候補があればそれを選ぶ (先頭でなくても)", () => {
    const candidates: WriteTargetCandidate[] = [
      { accountId: "acc-1", calendarId: "cal-1" },
      { accountId: "acc-1", calendarId: "cal-2", primary: true },
      { accountId: "acc-2", calendarId: "cal-3" },
    ];
    expect(resolveDefaultWriteTarget(candidates)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-2",
      primary: true,
    });
  });

  it("primary が無ければ先頭 (候補の並び順) を選ぶ", () => {
    const candidates: WriteTargetCandidate[] = [
      { accountId: "acc-1", calendarId: "cal-1", defaultColor: "#111111" },
      { accountId: "acc-2", calendarId: "cal-2" },
    ];
    expect(resolveDefaultWriteTarget(candidates)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#111111",
    });
  });
});

describe("buildEventCreateRequest", () => {
  it("title/startMs/endMs/target/timeZone から EventCreateRequest を組み立てる", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    const req = buildEventCreateRequest({
      title: "打ち合わせ",
      startMs: 1_000,
      endMs: 4_600_000,
      target,
      timeZone: "Asia/Tokyo",
    });
    expect(req).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      title: "打ち合わせ",
      startMs: 1_000,
      endMs: 4_600_000,
      timeZone: "Asia/Tokyo",
    });
  });
});

describe("buildPendingOccurrenceId", () => {
  it("local-pending- プレフィックス付きの一意な id を返す", () => {
    const a = buildPendingOccurrenceId();
    const b = buildPendingOccurrenceId();
    expect(a).toMatch(/^local-pending-/);
    expect(a).not.toBe(b);
  });
});

describe("buildPendingOccurrence", () => {
  it('source:"local" の仮 occurrence を作る (書き込み先カレンダー色を使う)', () => {
    const target: WriteTargetCandidate = {
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#22c55e",
    };
    const occ = buildPendingOccurrence({
      title: "ランチ",
      startMs: 1_000,
      endMs: 4_600_000,
      target,
    });
    expect(occ.title).toBe("ランチ");
    expect(occ.startMs).toBe(1_000);
    expect(occ.endMs).toBe(4_600_000);
    expect(occ.source).toBe("local");
    expect(occ.seriesId).toBeNull();
    expect(occ.color).toBe("#22c55e");
    expect(occ.hasCustomColor).toBe(false);
    expect(occ.id).toMatch(/^local-pending-/);
  });

  it("書き込み先にカレンダー色が無ければデフォルト色にフォールバックする", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    const occ = buildPendingOccurrence({
      title: "ランチ",
      startMs: 1_000,
      endMs: 4_600_000,
      target,
    });
    expect(occ.color).toBe("#3b82f6");
  });
});

describe("finalizeCreatedOccurrence", () => {
  it('仮 occurrence を確定 id・source:"google" に差し替える', () => {
    const target: WriteTargetCandidate = {
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#22c55e",
    };
    const pending = buildPendingOccurrence({
      title: "ランチ",
      startMs: 1_000,
      endMs: 4_600_000,
      target,
    });
    const finalized = finalizeCreatedOccurrence(pending, target, "evt-abc");
    expect(finalized.id).toBe("g:acc-1:cal-1:evt-abc");
    expect(finalized.source).toBe("google");
    expect(finalized.accountId).toBe("acc-1");
    expect(finalized.calendarId).toBe("cal-1");
    expect(finalized.color).toBe("#22c55e");
    expect(finalized.hasCustomColor).toBe(false);
    // title/startMs/endMs は据え置き
    expect(finalized.title).toBe("ランチ");
    expect(finalized.startMs).toBe(1_000);
    expect(finalized.endMs).toBe(4_600_000);
  });

  it("mapGoogle.ts の eventKey() と同じ id 規則になる (SSE/同期の冪等上書きの前提)", () => {
    const target: WriteTargetCandidate = { accountId: "acc-9", calendarId: "cal-9" };
    const pending = buildPendingOccurrence({ title: "x", startMs: 0, endMs: 1, target });
    const finalized = finalizeCreatedOccurrence(pending, target, "raw-event-id");
    expect(finalized.id).toBe("g:acc-9:cal-9:raw-event-id");
  });
});
