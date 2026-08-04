import type { CalendarListEntryDTO, GoogleEventDTO } from "@kichijitsu/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_CLEANUP_ITEMS,
  classifyMirrorState,
  extractOrphanMirrors,
  indexLiveRuleIds,
  isOrphanMirror,
  isValidBlockMirrorCleanupRequest,
  isWritableCalendar,
  type LiveMirrorRuleRef,
} from "../src/core/block-orphans";
import { MIRROR_MARKER_KEY, MIRROR_RULE_KEY, MIRROR_SOURCE_KEY } from "../src/core/block-reconcile";

const ACCOUNT = "acc-1";
const CALENDAR = "cal-1";

function mirrorEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: "mirror-1",
    status: "confirmed",
    start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    extendedProperties: {
      private: {
        [MIRROR_MARKER_KEY]: "1",
        [MIRROR_RULE_KEY]: "rule-1",
        [MIRROR_SOURCE_KEY]: "src-ev-1",
      },
    },
    ...overrides,
  };
}

function liveRule(overrides: Partial<LiveMirrorRuleRef> = {}): LiveMirrorRuleRef {
  return { id: "rule-1", targetAccountId: ACCOUNT, targetCalendarId: CALENDAR, ...overrides };
}

describe("indexLiveRuleIds / classifyMirrorState", () => {
  it("target と id が一致するルールがあれば alive", () => {
    const index = indexLiveRuleIds([liveRule()]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("alive");
  });

  it("ルールが1件も無ければ orphan", () => {
    const index = indexLiveRuleIds([]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("orphan");
  });

  it("同じ id のルールでも target のアカウントが違えば orphan (target 変更で残った孤児)", () => {
    const index = indexLiveRuleIds([liveRule({ targetAccountId: "other-acc" })]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("orphan");
  });

  it("同じ id のルールでも target のカレンダーが違えば orphan", () => {
    const index = indexLiveRuleIds([liveRule({ targetCalendarId: "other-cal" })]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("orphan");
  });

  it("target は一致するが id が違うルールしか無ければ orphan (ルール削除→別ルール新規作成)", () => {
    const index = indexLiveRuleIds([liveRule({ id: "rule-2" })]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("orphan");
  });

  it("kichijitsuMirror の目印が無い予定は not_a_mirror (孤児ではなく対象外)", () => {
    const index = indexLiveRuleIds([liveRule()]);
    const plain: GoogleEventDTO = {
      id: "ev-plain",
      status: "confirmed",
      start: { dateTime: "2026-07-20T10:00:00+09:00" },
      end: { dateTime: "2026-07-20T11:00:00+09:00" },
    };
    expect(classifyMirrorState(ACCOUNT, CALENDAR, plain, index)).toBe("not_a_mirror");
  });

  it("kichijitsuRule を持たないミラーは (由来不明で誰も管理できないため) orphan", () => {
    const index = indexLiveRuleIds([liveRule()]);
    const legacyMirror = mirrorEvent({
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1" } },
    });
    expect(classifyMirrorState(ACCOUNT, CALENDAR, legacyMirror, index)).toBe("orphan");
  });

  it("cancelled のミラーは (Google 上で既に消えているため) cancelled であり orphan ではない", () => {
    const index = indexLiveRuleIds([]);
    const cancelled = mirrorEvent({ status: "cancelled" });
    expect(classifyMirrorState(ACCOUNT, CALENDAR, cancelled, index)).toBe("cancelled");
    expect(isOrphanMirror(ACCOUNT, CALENDAR, cancelled, index)).toBe(false);
  });

  it("同じ target に複数ルールがあっても、いずれか1つの id と一致すれば alive", () => {
    const index = indexLiveRuleIds([liveRule({ id: "rule-a" }), liveRule({ id: "rule-1" })]);
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("alive");
  });

  /**
   * リコンサイラとの取り合い防止 (docs/blocking.md「将来やるならこれ」の設計理由そのもの):
   * insert 成功直後に D1 (block_mirrors) 書き込みが失敗したミラーは対応表に無いが、ルール自体は
   * 生きている ―― この定義では「生きている」側に入り、掃除機能が誤って消すことは無い。
   */
  it("block_mirrors に対応表が無くても、ルールが生きていれば alive (リコンサイラの採用対象を奪わない)", () => {
    const index = indexLiveRuleIds([liveRule()]);
    // block_mirrors には一切触れていない (indexLiveRuleIds は block_rules だけを見る) ことを
    // 示すため、渡すのは liveRule だけ。
    expect(classifyMirrorState(ACCOUNT, CALENDAR, mirrorEvent(), index)).toBe("alive");
  });
});

describe("extractOrphanMirrors", () => {
  it("孤児だけを OrphanMirrorDTO の形で返し、生きているミラーは含めない", () => {
    const index = indexLiveRuleIds([liveRule({ id: "rule-alive" })]);
    const alive = mirrorEvent({ id: "mirror-alive", extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1", [MIRROR_RULE_KEY]: "rule-alive", [MIRROR_SOURCE_KEY]: "src-a" } } });
    const orphan = mirrorEvent({ id: "mirror-orphan", extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1", [MIRROR_RULE_KEY]: "rule-gone", [MIRROR_SOURCE_KEY]: "src-b" } } });

    const result = extractOrphanMirrors(ACCOUNT, CALENDAR, [alive, orphan], index);

    expect(result).toEqual([
      {
        accountId: ACCOUNT,
        calendarId: CALENDAR,
        eventId: "mirror-orphan",
        start: { dateTime: "2026-07-20T10:00:00+09:00" },
        end: { dateTime: "2026-07-20T11:00:00+09:00" },
        ruleId: "rule-gone",
        sourceEventId: "src-b",
      },
    ]);
  });

  it("予定の内容 (summary 等) は一切含めない (無内容原則)", () => {
    const index = indexLiveRuleIds([]);
    const orphan = mirrorEvent({ summary: "予定あり", location: "should not leak" });
    const [result] = extractOrphanMirrors(ACCOUNT, CALENDAR, [orphan], index);
    expect(result).not.toHaveProperty("summary");
    expect(result).not.toHaveProperty("location");
  });

  it("start/end の timeZone は落とし、dateTime/date だけを写す", () => {
    const index = indexLiveRuleIds([]);
    const orphan = mirrorEvent({
      start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    });
    const [result] = extractOrphanMirrors(ACCOUNT, CALENDAR, [orphan], index);
    expect(result?.start).toEqual({ dateTime: "2026-07-20T10:00:00+09:00" });
    expect(result?.end).toEqual({ dateTime: "2026-07-20T11:00:00+09:00" });
  });

  it("終日予定 (date のみ) も正しく写す", () => {
    const index = indexLiveRuleIds([]);
    const orphan = mirrorEvent({ start: { date: "2026-07-20" }, end: { date: "2026-07-21" } });
    const [result] = extractOrphanMirrors(ACCOUNT, CALENDAR, [orphan], index);
    expect(result?.start).toEqual({ date: "2026-07-20" });
    expect(result?.end).toEqual({ date: "2026-07-21" });
  });

  it("kichijitsuRule/kichijitsuSource が無ければ null を返す (undefined ではない、API 契約通り)", () => {
    const index = indexLiveRuleIds([]);
    const legacyMirror = mirrorEvent({
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1" } },
    });
    const [result] = extractOrphanMirrors(ACCOUNT, CALENDAR, [legacyMirror], index);
    expect(result?.ruleId).toBeNull();
    expect(result?.sourceEventId).toBeNull();
  });

  it("mirror でない予定・cancelled のミラーは結果に含めない", () => {
    const index = indexLiveRuleIds([]);
    const plain: GoogleEventDTO = {
      id: "ev-plain",
      status: "confirmed",
      start: { dateTime: "2026-07-20T10:00:00+09:00" },
      end: { dateTime: "2026-07-20T11:00:00+09:00" },
    };
    const cancelled = mirrorEvent({ id: "mirror-cancelled", status: "cancelled" });
    expect(extractOrphanMirrors(ACCOUNT, CALENDAR, [plain, cancelled], index)).toEqual([]);
  });
});

describe("isWritableCalendar", () => {
  function calendar(overrides: Partial<CalendarListEntryDTO> = {}): CalendarListEntryDTO {
    return { id: "cal-1", summary: "Test", ...overrides };
  }

  it("owner は書き込み可能", () => {
    expect(isWritableCalendar(calendar({ accessRole: "owner" }))).toBe(true);
  });

  it("writer は書き込み可能", () => {
    expect(isWritableCalendar(calendar({ accessRole: "writer" }))).toBe(true);
  });

  it("reader は書き込み不可", () => {
    expect(isWritableCalendar(calendar({ accessRole: "reader" }))).toBe(false);
  });

  it("freeBusyReader は書き込み不可", () => {
    expect(isWritableCalendar(calendar({ accessRole: "freeBusyReader" }))).toBe(false);
  });

  it("accessRole 省略 (旧クライアント/取得失敗時) は安全側に倒して書き込み不可とみなす", () => {
    expect(isWritableCalendar(calendar({ accessRole: undefined }))).toBe(false);
  });
});

describe("isValidBlockMirrorCleanupRequest", () => {
  it("items が {accountId, calendarId, eventId} の配列なら valid", () => {
    expect(
      isValidBlockMirrorCleanupRequest({
        items: [{ accountId: "a", calendarId: "c", eventId: "e" }],
      }),
    ).toBe(true);
  });

  it("items が空配列でも型としては valid (件数0の拒否はルート側の責務)", () => {
    expect(isValidBlockMirrorCleanupRequest({ items: [] })).toBe(true);
  });

  it("items が無ければ invalid", () => {
    expect(isValidBlockMirrorCleanupRequest({})).toBe(false);
  });

  it("items が配列でなければ invalid", () => {
    expect(isValidBlockMirrorCleanupRequest({ items: "not-an-array" })).toBe(false);
  });

  it("要素のいずれかのフィールドが空文字なら invalid", () => {
    expect(
      isValidBlockMirrorCleanupRequest({
        items: [{ accountId: "", calendarId: "c", eventId: "e" }],
      }),
    ).toBe(false);
  });

  it("要素のいずれかのフィールドが欠けていれば invalid", () => {
    expect(
      isValidBlockMirrorCleanupRequest({ items: [{ accountId: "a", calendarId: "c" }] }),
    ).toBe(false);
  });

  it("body 自体が null/非オブジェクトなら invalid", () => {
    expect(isValidBlockMirrorCleanupRequest(null)).toBe(false);
    expect(isValidBlockMirrorCleanupRequest("items")).toBe(false);
  });
});

describe("MAX_CLEANUP_ITEMS", () => {
  it("500 件 (プロンプトの例) を上限とする", () => {
    expect(MAX_CLEANUP_ITEMS).toBe(500);
  });
});
