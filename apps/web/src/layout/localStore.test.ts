import { describe, expect, it } from "vite-plus/test";
import {
  readStored,
  readStoredStringSet,
  removeStored,
  writeStored,
  writeStoredStringSet,
  type StorageLike,
} from "./localStore";

/** localStorage のフェイク(テスト環境に window が無いため常に明示的に渡す) */
function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** プライベートモード等、あらゆる操作が throw する localStorage */
const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

describe("readStored", () => {
  it("保存値を parse して返す", () => {
    const s = fakeStorage({ "kichijitsu:view": "week" });
    expect(readStored("kichijitsu:view", (raw) => raw, "day1", s)).toBe("week");
  });

  it("未保存(getItem が null)なら fallback", () => {
    const s = fakeStorage();
    expect(readStored("missing", (raw) => raw, "fallback", s)).toBe("fallback");
  });

  it("parse が null を返したら(不正値)fallback", () => {
    const s = fakeStorage({ k: "bogus" });
    expect(readStored("k", (raw) => (raw === "ok" ? raw : null), "fallback", s)).toBe("fallback");
  });

  it("空文字も parse に通す(空を有効値とみなさない既存判定に合わせる)", () => {
    const s = fakeStorage({ k: "" });
    expect(readStored("k", (raw) => (raw.length > 0 ? raw : null), "fallback", s)).toBe("fallback");
  });

  it("parse が throw しても fallback へ静かに落ちる", () => {
    const s = fakeStorage({ k: "{" });
    expect(
      readStored<unknown>("k", (raw) => JSON.parse(raw) as unknown, "fallback", s),
    ).toBe("fallback");
  });

  it("localStorage 自体が throw する環境(プライベートモード等)でも fallback", () => {
    expect(readStored("k", (raw) => raw, "fallback", throwingStorage)).toBe("fallback");
  });

  it("storage を渡さない環境(window 無し)では fallback", () => {
    // テスト環境には window が無いため resolveStorage が null を返す経路を通る
    expect(readStored("k", (raw) => raw, "fallback")).toBe("fallback");
  });

  it("fallback に null を使える(「保存が無ければ呼び出し側で決める」用途)", () => {
    const s = fakeStorage();
    expect(readStored<string | null>("k", (raw) => raw, null, s)).toBeNull();
  });
});

describe("writeStored / removeStored", () => {
  it("値を書き込む", () => {
    const s = fakeStorage();
    writeStored("k", "v", s);
    expect(s.data.get("k")).toBe("v");
  });

  it("値を削除する", () => {
    const s = fakeStorage({ k: "v" });
    removeStored("k", s);
    expect(s.data.has("k")).toBe(false);
  });

  it("書き込み/削除が throw しても伝播させない(保存できないだけで機能は継続)", () => {
    expect(() => writeStored("k", "v", throwingStorage)).not.toThrow();
    expect(() => removeStored("k", throwingStorage)).not.toThrow();
  });

  it("storage を渡さない環境でも throw しない", () => {
    expect(() => writeStored("k", "v")).not.toThrow();
    expect(() => removeStored("k")).not.toThrow();
  });
});

describe("readStoredStringSet / writeStoredStringSet", () => {
  it("JSON 配列を Set として読む", () => {
    const s = fakeStorage({ k: '["a","b"]' });
    expect([...readStoredStringSet("k", s)]).toEqual(["a", "b"]);
  });

  it("未保存なら空集合", () => {
    expect([...readStoredStringSet("k", fakeStorage())]).toEqual([]);
  });

  it("壊れた JSON なら空集合", () => {
    expect([...readStoredStringSet("k", fakeStorage({ k: "{{{" }))]).toEqual([]);
  });

  it("配列でない JSON なら空集合", () => {
    expect([...readStoredStringSet("k", fakeStorage({ k: '{"a":1}' }))]).toEqual([]);
  });

  it("文字列以外の要素は捨てて文字列だけ拾う(既存の寛容さを維持)", () => {
    const s = fakeStorage({ k: '["a",1,null,"b"]' });
    expect([...readStoredStringSet("k", s)]).toEqual(["a", "b"]);
  });

  it("書き込みは JSON 配列(挿入順)、読み戻しで往復する", () => {
    const s = fakeStorage();
    writeStoredStringSet("k", new Set(["x", "y"]), s);
    expect(s.data.get("k")).toBe('["x","y"]');
    expect([...readStoredStringSet("k", s)]).toEqual(["x", "y"]);
  });

  it("localStorage が throw する環境でも空集合/無操作で済む", () => {
    expect([...readStoredStringSet("k", throwingStorage)]).toEqual([]);
    expect(() => writeStoredStringSet("k", new Set(["a"]), throwingStorage)).not.toThrow();
  });
});
