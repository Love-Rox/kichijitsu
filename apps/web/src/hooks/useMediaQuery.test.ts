import { describe, expect, it, vi } from "vite-plus/test";
import { subscribeMediaQuery, type MediaQueryListLike } from "./useMediaQuery";

/** MediaQueryListLike のフェイク。change リスナーを直接呼び出して変化を模擬できる */
function fakeMql(
  initialMatches: boolean,
): MediaQueryListLike & { fireChange: (matches: boolean) => void } {
  let listener: ((event: { matches: boolean }) => void) | null = null;
  return {
    matches: initialMatches,
    addEventListener: vi.fn((_type, l) => {
      listener = l;
    }),
    removeEventListener: vi.fn((_type, l) => {
      if (listener === l) listener = null;
    }),
    fireChange(matches: boolean) {
      listener?.({ matches });
    },
  };
}

describe("subscribeMediaQuery", () => {
  it("購読開始時に現在値を即座に setMatches へ反映する", () => {
    const mql = fakeMql(true);
    const setMatches = vi.fn();
    subscribeMediaQuery(mql, setMatches);
    expect(setMatches).toHaveBeenCalledWith(true);
  });

  it("change イベントを setMatches へそのまま流す", () => {
    const mql = fakeMql(false);
    const setMatches = vi.fn();
    subscribeMediaQuery(mql, setMatches);
    setMatches.mockClear();

    mql.fireChange(true);
    expect(setMatches).toHaveBeenCalledWith(true);

    mql.fireChange(false);
    expect(setMatches).toHaveBeenCalledWith(false);
  });

  it("戻り値の解除関数を呼ぶと以後の change を無視する", () => {
    const mql = fakeMql(false);
    const setMatches = vi.fn();
    const unsubscribe = subscribeMediaQuery(mql, setMatches);
    setMatches.mockClear();

    unsubscribe();
    mql.fireChange(true);
    expect(setMatches).not.toHaveBeenCalled();
  });
});
