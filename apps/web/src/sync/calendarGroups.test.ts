import { describe, expect, it } from "vite-plus/test";
import type { CalendarListEntryDTO } from "@kichijitsu/shared";
import { groupCalendarsByAccess } from "./calendarGroups";

function cal(overrides: Partial<CalendarListEntryDTO> = {}): CalendarListEntryDTO {
  return {
    id: "cal-1",
    summary: "Calendar 1",
    ...overrides,
  };
}

describe("groupCalendarsByAccess", () => {
  it("accessRole===owner を mine、それ以外を others に振り分ける", () => {
    const result = groupCalendarsByAccess([
      cal({ id: "a", accessRole: "owner" }),
      cal({ id: "b", accessRole: "writer" }),
      cal({ id: "c", accessRole: "reader" }),
      cal({ id: "d", accessRole: "freeBusyReader" }),
    ]);
    expect(result.mine.map((c) => c.id)).toEqual(["a"]);
    expect(result.others.map((c) => c.id)).toEqual(["b", "c", "d"]);
  });

  it("accessRole 未設定(取得失敗・レガシーキャッシュ由来)は others に倒す(安全側)", () => {
    const result = groupCalendarsByAccess([cal({ id: "a" })]);
    expect(result.mine).toEqual([]);
    expect(result.others.map((c) => c.id)).toEqual(["a"]);
  });

  it("primary な owner カレンダーを mine の先頭に並べる", () => {
    const result = groupCalendarsByAccess([
      cal({ id: "a", accessRole: "owner", primary: false }),
      cal({ id: "b", accessRole: "owner", primary: true }),
      cal({ id: "c", accessRole: "owner", primary: false }),
    ]);
    expect(result.mine.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("primary 以外の mine 内の相対順序は元の並びのまま安定ソートされる", () => {
    const result = groupCalendarsByAccess([
      cal({ id: "z", accessRole: "owner" }),
      cal({ id: "a", accessRole: "owner" }),
      cal({ id: "m", accessRole: "owner" }),
    ]);
    expect(result.mine.map((c) => c.id)).toEqual(["z", "a", "m"]);
  });

  it("空配列を渡すと mine/others とも空配列を返す", () => {
    const result = groupCalendarsByAccess([]);
    expect(result.mine).toEqual([]);
    expect(result.others).toEqual([]);
  });
});
