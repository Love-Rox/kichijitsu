import { describe, expect, it } from "vite-plus/test";
import { parseDesktopEvent } from "./useDesktopEvents";

describe("parseDesktopEvent", () => {
  it("quickCreate と focusEvent だけを受け付ける", () => {
    expect(parseDesktopEvent({ kind: "quickCreate" })).toEqual({ kind: "quickCreate" });
    expect(parseDesktopEvent({ kind: "focusEvent", startMs: 1_700_000_000_000 })).toEqual({
      kind: "focusEvent",
      startMs: 1_700_000_000_000,
    });
  });
  it("形が違うもの・数でない startMs・知らない種類は無視する", () => {
    expect(parseDesktopEvent(null)).toBeNull();
    expect(parseDesktopEvent("quickCreate")).toBeNull();
    expect(parseDesktopEvent({ kind: "focusEvent" })).toBeNull();
    expect(parseDesktopEvent({ kind: "focusEvent", startMs: "1" })).toBeNull();
    expect(parseDesktopEvent({ kind: "focusEvent", startMs: Number.NaN })).toBeNull();
    expect(parseDesktopEvent({ kind: "somethingElse" })).toBeNull();
  });
});
