import { describe, expect, it } from "vite-plus/test";
import {
  buildCreateDraft,
  buildDuplicateDraft,
  buildEventCreateRequest,
  buildPendingAllDayOccurrence,
  buildPendingOccurrence,
  buildPendingOccurrenceId,
  canDuplicateOccurrence,
  duplicateWriteTarget,
  findWriteTarget,
  finalizeCreatedAllDayOccurrence,
  finalizeCreatedOccurrence,
  normalizeEventCreateDraft,
  resolveDefaultWriteTarget,
  writeTargetKey,
  type EventCreateDraft,
  type WriteTargetCandidate,
} from "./eventCreate";
import { validateEventEditDraft } from "./eventEdit";
import type { Occurrence } from "../model/types";

const TZ = "Asia/Tokyo";

/** 2026-07-20 (月) 10:00 JST */
const START_MS = Date.UTC(2026, 6, 20, 1, 0);
/** 2026-07-20 (月) 11:00 JST */
const END_MS = Date.UTC(2026, 6, 20, 2, 0);

function draft(overrides: Partial<EventCreateDraft> = {}): EventCreateDraft {
  return { ...buildCreateDraft(START_MS, END_MS, "打ち合わせ"), ...overrides };
}

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

describe("writeTargetKey / findWriteTarget", () => {
  const candidates: WriteTargetCandidate[] = [
    { accountId: "acc-1", calendarId: "cal-1" },
    { accountId: "acc-2", calendarId: "cal-2", defaultColor: "#22c55e" },
  ];

  it("layout/keys.ts の calendarKey と同じ `accountId:calendarId` 形式", () => {
    expect(writeTargetKey(candidates[0])).toBe("acc-1:cal-1");
  });

  it("キーで候補を引き当てる", () => {
    expect(findWriteTarget(candidates, "acc-2:cal-2")).toEqual(candidates[1]);
  });

  it("選択肢から消えたキーは null (カレンダー表示を切ったあとの保険)", () => {
    expect(findWriteTarget(candidates, "acc-9:cal-9")).toBeNull();
  });
});

describe("buildCreateDraft", () => {
  it("時間帯だけの空 draft を作る (速い経路と詳細フォームの共通の起点)", () => {
    expect(buildCreateDraft(START_MS, END_MS)).toEqual({
      title: "",
      location: "",
      description: "",
      isAllDay: false,
      startMs: START_MS,
      endMs: END_MS,
    });
  });

  it("タイトルだけ差し替えられる (インライン入力からの引き継ぎ)", () => {
    expect(buildCreateDraft(START_MS, END_MS, "ランチ").title).toBe("ランチ");
  });

  it("編集フォームと同じバリデーションをそのまま通せる形になっている", () => {
    expect(validateEventEditDraft(buildCreateDraft(START_MS, END_MS, "ランチ"))).toBeNull();
    // タイトル空・終了が開始以前は編集と同じ理由で弾かれる (作成専用の規則は増やさない)
    expect(validateEventEditDraft(buildCreateDraft(START_MS, END_MS))).toBe(
      "タイトルを入力してください",
    );
    expect(validateEventEditDraft(buildCreateDraft(END_MS, START_MS, "逆転"))).toBe(
      "終了日時は開始日時より後にしてください",
    );
  });
});

describe("normalizeEventCreateDraft", () => {
  it("タイトルと場所の前後空白を落とす (速い経路の title.trim() と揃える)", () => {
    const normalized = normalizeEventCreateDraft(
      draft({ title: "  打ち合わせ  ", location: "  会議室A " }),
    );
    expect(normalized.title).toBe("打ち合わせ");
    expect(normalized.location).toBe("会議室A");
  });

  it("説明は触らない (複数行テキストの前後の空行にも意味があり得るため)", () => {
    expect(normalizeEventCreateDraft(draft({ description: "\n議題\n\n" })).description).toBe(
      "\n議題\n\n",
    );
  });
});

describe("buildEventCreateRequest", () => {
  const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };

  it("速い経路 (タイトルのみ) では場所/説明/終日のキーを送らない", () => {
    const req = buildEventCreateRequest({ draft: draft(), target, timeZone: TZ });
    expect(req).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      title: "打ち合わせ",
      startMs: START_MS,
      endMs: END_MS,
      timeZone: TZ,
    });
  });

  it("詳細フォームで入れた場所/説明/終日を載せる", () => {
    const req = buildEventCreateRequest({
      draft: draft({ location: "会議室A", description: "議題まとめ", isAllDay: true }),
      target,
      timeZone: TZ,
    });
    expect(req.location).toBe("会議室A");
    expect(req.description).toBe("議題まとめ");
    expect(req.isAllDay).toBe(true);
  });

  it("空欄はキーごと省く (作成には「クリアすべき既存値」が無いので空文字は送らない)", () => {
    const req = buildEventCreateRequest({
      draft: draft({ location: "   ", description: "" }),
      target,
      timeZone: TZ,
    });
    expect("location" in req).toBe(false);
    expect("description" in req).toBe(false);
    expect("isAllDay" in req).toBe(false);
  });

  it("タイトルは trim してから送る (詳細フォーム経由でも速い経路と同じ結果になる)", () => {
    const req = buildEventCreateRequest({
      draft: draft({ title: "  打ち合わせ " }),
      target,
      timeZone: TZ,
    });
    expect(req.title).toBe("打ち合わせ");
  });

  it("書き込み先は target のものを使う (既定ではなく利用者が選んだカレンダー)", () => {
    const chosen: WriteTargetCandidate = { accountId: "acc-2", calendarId: "cal-9" };
    const req = buildEventCreateRequest({ draft: draft(), target: chosen, timeZone: TZ });
    expect(req.accountId).toBe("acc-2");
    expect(req.calendarId).toBe("cal-9");
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
    const occ = buildPendingOccurrence({ draft: draft({ title: "ランチ" }), target });
    expect(occ.title).toBe("ランチ");
    expect(occ.startMs).toBe(START_MS);
    expect(occ.endMs).toBe(END_MS);
    expect(occ.source).toBe("local");
    expect(occ.seriesId).toBeNull();
    expect(occ.color).toBe("#22c55e");
    expect(occ.hasCustomColor).toBe(false);
    expect(occ.id).toMatch(/^local-pending-/);
  });

  it("書き込み先にカレンダー色が無ければデフォルト色にフォールバックする", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    expect(buildPendingOccurrence({ draft: draft(), target }).color).toBe("#3b82f6");
  });

  it("場所/説明も楽観表示に載せる (確定を待たずに詳細ポップオーバーへ出るように)", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    const occ = buildPendingOccurrence({
      draft: draft({ location: "会議室A", description: "議題" }),
      target,
    });
    expect(occ.location).toBe("会議室A");
    expect(occ.description).toBe("議題");
  });

  it("空欄の場所/説明は undefined にする (空文字を持ち回らない)", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    const occ = buildPendingOccurrence({ draft: draft(), target });
    expect(occ.location).toBeUndefined();
    expect(occ.description).toBeUndefined();
  });
});

describe("buildPendingAllDayOccurrence", () => {
  const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
  /** 2026-07-20 (月) 0:00 JST */
  const day0 = Date.UTC(2026, 6, 19, 15, 0);
  const dayMs = 24 * 60 * 60_000;

  it("排他的な endMs を inclusive な endDate に1日前倒しする (単日)", () => {
    const occ = buildPendingAllDayOccurrence({
      draft: draft({ isAllDay: true, startMs: day0, endMs: day0 + dayMs }),
      target,
      timeZone: TZ,
    });
    expect(occ.startDate).toBe("2026-07-20");
    expect(occ.endDate).toBe("2026-07-20");
    expect(occ.source).toBe("local");
    expect(occ.seriesId).toBeNull();
    expect(occ.id).toMatch(/^local-pending-/);
  });

  it("複数日にまたがる終日予定の endDate", () => {
    const occ = buildPendingAllDayOccurrence({
      draft: draft({ isAllDay: true, startMs: day0, endMs: day0 + 3 * dayMs }),
      target,
      timeZone: TZ,
    });
    expect(occ.startDate).toBe("2026-07-20");
    expect(occ.endDate).toBe("2026-07-22");
  });

  it("endDate が startDate より前になる異常値は startDate にクランプする", () => {
    const occ = buildPendingAllDayOccurrence({
      draft: draft({ isAllDay: true, startMs: day0, endMs: day0 }),
      target,
      timeZone: TZ,
    });
    expect(occ.endDate).toBe("2026-07-20");
  });
});

describe("finalizeCreatedOccurrence", () => {
  it('仮 occurrence を確定 id・source:"google" に差し替える', () => {
    const target: WriteTargetCandidate = {
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#22c55e",
    };
    const pending = buildPendingOccurrence({ draft: draft({ title: "ランチ" }), target });
    const finalized = finalizeCreatedOccurrence(pending, target, "evt-abc");
    expect(finalized.id).toBe("g:acc-1:cal-1:evt-abc");
    expect(finalized.source).toBe("google");
    expect(finalized.accountId).toBe("acc-1");
    expect(finalized.calendarId).toBe("cal-1");
    expect(finalized.color).toBe("#22c55e");
    expect(finalized.hasCustomColor).toBe(false);
    // title/startMs/endMs は据え置き
    expect(finalized.title).toBe("ランチ");
    expect(finalized.startMs).toBe(START_MS);
    expect(finalized.endMs).toBe(END_MS);
  });

  it("mapGoogle.ts の eventKey() と同じ id 規則になる (SSE/同期の冪等上書きの前提)", () => {
    const target: WriteTargetCandidate = { accountId: "acc-9", calendarId: "cal-9" };
    const pending = buildPendingOccurrence({ draft: draft({ title: "x" }), target });
    const finalized = finalizeCreatedOccurrence(pending, target, "raw-event-id");
    expect(finalized.id).toBe("g:acc-9:cal-9:raw-event-id");
  });

  it("場所/説明は確定後も残る", () => {
    const target: WriteTargetCandidate = { accountId: "acc-1", calendarId: "cal-1" };
    const pending = buildPendingOccurrence({ draft: draft({ location: "会議室A" }), target });
    expect(finalizeCreatedOccurrence(pending, target, "e").location).toBe("会議室A");
  });
});

describe("finalizeCreatedAllDayOccurrence", () => {
  it("終日でも同じ id 規則・同じ差し替え規則になる", () => {
    const target: WriteTargetCandidate = {
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#22c55e",
    };
    const day0 = Date.UTC(2026, 6, 19, 15, 0);
    const pending = buildPendingAllDayOccurrence({
      draft: draft({ isAllDay: true, startMs: day0, endMs: day0 + 24 * 60 * 60_000 }),
      target,
      timeZone: TZ,
    });
    const finalized = finalizeCreatedAllDayOccurrence(pending, target, "evt-all");
    expect(finalized.id).toBe("g:acc-1:cal-1:evt-all");
    expect(finalized.source).toBe("google");
    expect(finalized.startDate).toBe("2026-07-20");
    expect(finalized.endDate).toBe("2026-07-20");
    expect(finalized.color).toBe("#22c55e");
  });
});

// ---- Option(Alt)+ドラッグでの複製 (2026-07-29) ----

const SOURCE: Occurrence = {
  id: "g:acc-1:cal-1:evt-1",
  seriesId: null,
  title: "定例",
  startMs: Date.UTC(2026, 6, 20, 1, 0),
  endMs: Date.UTC(2026, 6, 20, 2, 0),
  color: "#3b82f6",
  hasCustomColor: false,
  source: "google",
  accountId: "acc-1",
  calendarId: "cal-1",
  location: "会議室A",
  description: "議事メモ",
};

describe("duplicateWriteTarget / canDuplicateOccurrence", () => {
  it("元の予定と同じカレンダーを書き込み先にする", () => {
    expect(duplicateWriteTarget(SOURCE)).toEqual({
      accountId: "acc-1",
      calendarId: "cal-1",
      defaultColor: "#3b82f6",
    });
    expect(canDuplicateOccurrence(SOURCE)).toBe(true);
  });

  it("ミラー / Busy プレースホルダ / 非 Google は複製できない(複製ドラッグを始めない)", () => {
    expect(canDuplicateOccurrence({ ...SOURCE, isMirror: true })).toBe(false);
    expect(canDuplicateOccurrence({ ...SOURCE, title: "予定あり" })).toBe(false);
    expect(canDuplicateOccurrence({ ...SOURCE, source: "local" })).toBe(false);
  });

  it("accountId / calendarId が無ければ書き込み先を特定できないので複製できない", () => {
    expect(duplicateWriteTarget({ ...SOURCE, calendarId: undefined })).toBeNull();
    expect(duplicateWriteTarget({ ...SOURCE, accountId: undefined })).toBeNull();
  });
});

describe("buildDuplicateDraft", () => {
  it("タイトル/場所/説明を引き継ぎ、時刻だけドロップ先に差し替える", () => {
    const startMs = Date.UTC(2026, 6, 21, 4, 0);
    const endMs = startMs + 60 * 60_000;
    expect(buildDuplicateDraft(SOURCE, startMs, endMs)).toEqual({
      title: "定例",
      location: "会議室A",
      description: "議事メモ",
      isAllDay: false,
      startMs,
      endMs,
    });
  });

  it("場所/説明が無い予定でも空文字で埋まる(EventCreateRequest ではキー自体が落ちる)", () => {
    const bare = { ...SOURCE, location: undefined, description: undefined };
    const d = buildDuplicateDraft(bare, 0, 60_000);
    expect(d.location).toBe("");
    expect(d.description).toBe("");
    const req = buildEventCreateRequest({
      draft: d,
      target: duplicateWriteTarget(bare)!,
      timeZone: TZ,
    });
    expect("location" in req).toBe(false);
    expect("description" in req).toBe(false);
  });

  it("シリーズ由来の1回分を複製すると、単発の新しい予定になる(seriesId を持ち込まない)", () => {
    const instance: Occurrence = { ...SOURCE, seriesId: "series-1", originalStartMs: SOURCE.startMs };
    const target = duplicateWriteTarget(instance)!;
    const pending = buildPendingOccurrence({
      draft: buildDuplicateDraft(instance, 0, 60_000),
      target,
    });
    expect(pending.seriesId).toBeNull();
  });
});
