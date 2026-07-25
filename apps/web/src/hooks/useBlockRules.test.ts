import { describe, expect, it } from "vite-plus/test";
import type { BlockRuleDTO } from "@kichijitsu/shared";
import { upsertBlockRule } from "./useBlockRules";

/** テスト用の最小 BlockRuleDTO。判別に使うのは id と mode だけ */
function rule(id: string, mode: BlockRuleDTO["mode"] = "busy"): BlockRuleDTO {
  return {
    id,
    sources: [{ accountId: "acc-1", calendarId: "cal-src" }],
    target: { accountId: "acc-1", calendarId: "cal-dst" },
    mode,
    oooFallback: false,
  };
}

describe("upsertBlockRule", () => {
  it("未知の id は末尾に追加する(新規作成 = POST に id 無しのケース)", () => {
    const prev = [rule("a"), rule("b")];
    const next = upsertBlockRule(prev, rule("c"));
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("既知の id は同じ位置で置き換える(更新のケース、並び順を崩さない)", () => {
    const prev = [rule("a"), rule("b"), rule("c")];
    const next = upsertBlockRule(prev, rule("b", "outOfOffice"));
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(next[1].mode).toBe("outOfOffice");
  });

  it("引数の配列を変更しない(React state をそのまま渡せるように)", () => {
    const prev = [rule("a")];
    const snapshot = [...prev];
    upsertBlockRule(prev, rule("a", "outOfOffice"));
    upsertBlockRule(prev, rule("z"));
    expect(prev).toEqual(snapshot);
  });

  it("空の一覧に対しても追加できる(初回取得前に作成した場合)", () => {
    expect(upsertBlockRule([], rule("a")).map((r) => r.id)).toEqual(["a"]);
  });
});
