import { describe, expect, it } from "vite-plus/test";
import type { InstanceOverride } from "../model/series";
import { mergeOverridePatch, resolveOverrideRef } from "./overridePatch";

describe("resolveOverrideRef", () => {
  it("シリーズ由来の1回分は id/seriesId/originalStartMs を返す", () => {
    const ref = resolveOverrideRef({ seriesId: "g:acc-1:cal-1:series-1", originalStartMs: 1000 });
    expect(ref).toEqual({
      id: "g:acc-1:cal-1:series-1:1000",
      seriesId: "g:acc-1:cal-1:series-1",
      originalStartMs: 1000,
    });
  });

  it("単発予定 (seriesId=null) は undefined", () => {
    expect(resolveOverrideRef({ seriesId: null, originalStartMs: 1000 })).toBeUndefined();
  });

  it("originalStartMs が無ければ undefined(どの回への上書きか特定できない)", () => {
    expect(resolveOverrideRef({ seriesId: "series-1" })).toBeUndefined();
  });

  it("originalStartMs=0 は有効な値として扱う(falsy だが未定義ではない)", () => {
    expect(resolveOverrideRef({ seriesId: "series-1", originalStartMs: 0 })?.id).toBe("series-1:0");
  });
});

describe("mergeOverridePatch", () => {
  const ref = { id: "series-1:1000", seriesId: "series-1", originalStartMs: 1000 };

  it("既存 patch を保ったまま指定キーだけ上書きする(丸ごと置き換えない)", () => {
    // mapGoogle が例外インスタンスから写した値・編集フォームが書いた値が
    // ドラッグ確定で消えてしまわないことを固定する(実際に踏んだバグ)
    const existing: InstanceOverride = {
      ...ref,
      patch: {
        title: "1on1",
        startMs: 1000,
        endMs: 4600,
        conferenceUrl: "https://meet.example/abc",
        hasConference: true,
        responseStatus: "accepted",
        isOrganizer: true,
        location: "会議室A",
      },
    };
    const merged = mergeOverridePatch({
      ref,
      existing,
      fields: { startMs: 7200, endMs: 10800 },
    });
    expect(merged).toEqual({
      ...ref,
      patch: {
        title: "1on1",
        startMs: 7200,
        endMs: 10800,
        conferenceUrl: "https://meet.example/abc",
        hasConference: true,
        responseStatus: "accepted",
        isOrganizer: true,
        location: "会議室A",
      },
    });
  });

  it("override がまだ無ければ fields だけの patch になる", () => {
    expect(
      mergeOverridePatch({ ref, existing: undefined, fields: { responseStatus: "declined" } }),
    ).toEqual({ ...ref, patch: { responseStatus: "declined" } });
    expect(
      mergeOverridePatch({ ref, existing: null, fields: { responseStatus: "declined" } }),
    ).toEqual({ ...ref, patch: { responseStatus: "declined" } });
  });

  it("既存が patch:null(この回はキャンセル済み)なら空 patch 扱いで合成する", () => {
    const cancelled: InstanceOverride = { ...ref, patch: null };
    expect(mergeOverridePatch({ ref, existing: cancelled, fields: { startMs: 1 } })).toEqual({
      ...ref,
      patch: { startMs: 1 },
    });
  });

  it("fields に undefined で入れたキーは undefined で上書きされる(空文字で消す動線)", () => {
    const existing: InstanceOverride = { ...ref, patch: { location: "会議室A", title: "旧" } };
    const merged = mergeOverridePatch({
      ref,
      existing,
      fields: { title: "新", location: undefined },
    });
    expect(merged.patch).toEqual({ title: "新", location: undefined });
    expect(merged.patch && "location" in merged.patch).toBe(true);
  });

  it("引数の existing を書き換えない", () => {
    const existing: InstanceOverride = { ...ref, patch: { startMs: 1000 } };
    mergeOverridePatch({ ref, existing, fields: { startMs: 9999 } });
    expect(existing.patch).toEqual({ startMs: 1000 });
  });
});
