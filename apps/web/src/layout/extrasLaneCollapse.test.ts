import { describe, expect, it } from "vite-plus/test";
import type { StorageLike } from "./localStore";
import {
  DEFAULT_EXTRAS_LANE_COLLAPSED,
  getExtrasLaneCollapsed,
  normalizeExtrasLaneCollapsed,
  setExtrasLaneCollapsed,
} from "./extrasLaneCollapse";

function fakeStorage(
  initial: Record<string, string> = {},
): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const KEY = "kichijitsu:extrasLaneCollapsed";

describe("extrasLaneCollapse", () => {
  it("既定は畳む", () => {
    expect(DEFAULT_EXTRAS_LANE_COLLAPSED).toBe(true);
    expect(getExtrasLaneCollapsed(fakeStorage())).toBe(true);
  });

  it('"open" だけが展開で、それ以外(未設定・ゴミ値)は畳む', () => {
    expect(normalizeExtrasLaneCollapsed("open")).toBe(false);
    for (const raw of [null, undefined, "", "1", "0", "OPEN", "true"]) {
      expect(normalizeExtrasLaneCollapsed(raw)).toBe(true);
    }
  });

  it("展開すると保存され、畳み直すと保存値ごと消える", () => {
    const s = fakeStorage();
    setExtrasLaneCollapsed(false, s);
    expect(s.map.get(KEY)).toBe("open");
    expect(getExtrasLaneCollapsed(s)).toBe(false);
    setExtrasLaneCollapsed(true, s);
    expect(s.map.has(KEY)).toBe(false);
    expect(getExtrasLaneCollapsed(s)).toBe(true);
  });

  it("旧キー (githubLaneCollapsed) は読まない", () => {
    const s = fakeStorage({ "kichijitsu:githubLaneCollapsed": "1" });
    expect(getExtrasLaneCollapsed(s)).toBe(true);
  });
});
