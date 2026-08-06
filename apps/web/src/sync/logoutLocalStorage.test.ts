import { describe, expect, it } from "vite-plus/test";
import {
  clearKichijitsuLocalStorage,
  isLogoutClearableStorageKey,
  type EnumerableStorage,
} from "./logoutLocalStorage";

describe("isLogoutClearableStorageKey", () => {
  it("kichijitsu: 接頭辞のキーは対象", () => {
    expect(isLogoutClearableStorageKey("kichijitsu:view")).toBe(true);
    expect(isLogoutClearableStorageKey("kichijitsu:hourHeight")).toBe(true);
    expect(isLogoutClearableStorageKey("kichijitsu:reminderNotified")).toBe(true);
  });

  it("kichijitsu:theme だけは例外(配色設定なので残す)", () => {
    expect(isLogoutClearableStorageKey("kichijitsu:theme")).toBe(false);
  });

  it("他の名前空間・紛らわしい境界は対象外", () => {
    expect(isLogoutClearableStorageKey("other-app:view")).toBe(false);
    expect(isLogoutClearableStorageKey("kichijitsu")).toBe(false);
    expect(isLogoutClearableStorageKey("")).toBe(false);
  });
});

/** EnumerableStorage の最小スタブ。実装は Map を使うがキー順は挿入順を保つ(localStorage と同様) */
function stubStorage(initial: Record<string, string>): EnumerableStorage & {
  snapshot(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

describe("clearKichijitsuLocalStorage", () => {
  it("kichijitsu: のキーを消し、kichijitsu:theme と他の名前空間は残す", () => {
    const storage = stubStorage({
      "kichijitsu:view": "week",
      "kichijitsu:hourHeight": "48",
      "kichijitsu:theme": "dark",
      "other-app:setting": "x",
    });

    const removed = clearKichijitsuLocalStorage(storage);

    expect(removed.toSorted()).toEqual(["kichijitsu:hourHeight", "kichijitsu:view"]);
    expect(storage.snapshot()).toEqual({
      "kichijitsu:theme": "dark",
      "other-app:setting": "x",
    });
  });

  it("消すものが無ければ空配列で、既存のキーには触れない", () => {
    const storage = stubStorage({ "kichijitsu:theme": "light", "other-app:setting": "x" });

    const removed = clearKichijitsuLocalStorage(storage);

    expect(removed).toEqual([]);
    expect(storage.snapshot()).toEqual({ "kichijitsu:theme": "light", "other-app:setting": "x" });
  });

  it("走査中に削除しても添字ずれで読み飛ばさない(先に集めてから消す)", () => {
    // 挿入順で kichijitsu: の3件が連続する意地悪なケース。素朴に while (i < length) で
    // 都度 removeItem すると length が縮んで奇数番目を読み飛ばすことがある。
    const storage = stubStorage({
      "kichijitsu:a": "1",
      "kichijitsu:b": "2",
      "kichijitsu:c": "3",
    });

    const removed = clearKichijitsuLocalStorage(storage);

    expect(removed.toSorted()).toEqual(["kichijitsu:a", "kichijitsu:b", "kichijitsu:c"]);
    expect(storage.snapshot()).toEqual({});
  });
});
