import { describe, expect, it } from "vite-plus/test";
import type { StorageLike } from "./localStore";
import {
  DEFAULT_GITHUB_LANE_COLLAPSED,
  getGitHubLaneCollapsed,
  normalizeGitHubLaneCollapsed,
  setGitHubLaneCollapsed,
} from "./githubLaneCollapse";

/** localStore.test.ts / oooAllDayPlacement.test.ts と同じ流儀のフェイク(このテスト環境には window が無い) */
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

const KEY = "kichijitsu:githubLaneCollapsed";

describe("normalizeGitHubLaneCollapsed", () => {
  it('"1" だけが「畳んでいる」', () => {
    expect(normalizeGitHubLaneCollapsed("1")).toBe(true);
  });

  it("未設定 (null / undefined) は既定の展開 = 現状維持", () => {
    expect(normalizeGitHubLaneCollapsed(null)).toBe(false);
    expect(normalizeGitHubLaneCollapsed(undefined)).toBe(false);
  });

  it('"0" と空文字は展開', () => {
    expect(normalizeGitHubLaneCollapsed("0")).toBe(false);
    expect(normalizeGitHubLaneCollapsed("")).toBe(false);
  });

  it("ゆらぎ・想定外の値はすべて展開に倒す(完全一致のみ)", () => {
    expect(normalizeGitHubLaneCollapsed(" 1")).toBe(false);
    expect(normalizeGitHubLaneCollapsed("true")).toBe(false);
    expect(normalizeGitHubLaneCollapsed("collapsed")).toBe(false);
    expect(normalizeGitHubLaneCollapsed('{"collapsed":true}')).toBe(false);
  });

  it("既定値の定数と一致する", () => {
    expect(normalizeGitHubLaneCollapsed(null)).toBe(DEFAULT_GITHUB_LANE_COLLAPSED);
  });
});

describe("getGitHubLaneCollapsed / setGitHubLaneCollapsed", () => {
  it("畳んだ状態を読み戻せる", () => {
    const storage = fakeStorage();
    setGitHubLaneCollapsed(true, storage);
    expect(storage.map.get(KEY)).toBe("1");
    expect(getGitHubLaneCollapsed(storage)).toBe(true);
  });

  it("既定値 (展開) に戻すと保存値ごと消える(未設定と同じ状態に戻す)", () => {
    const storage = fakeStorage({ [KEY]: "1" });
    setGitHubLaneCollapsed(false, storage);
    expect(storage.map.has(KEY)).toBe(false);
    expect(getGitHubLaneCollapsed(storage)).toBe(false);
  });

  it("未設定・壊れた保存値はどちらも既定の展開", () => {
    expect(getGitHubLaneCollapsed(fakeStorage())).toBe(false);
    expect(getGitHubLaneCollapsed(fakeStorage({ [KEY]: "??" }))).toBe(false);
  });
});
