import { describe, expect, it } from "vite-plus/test";
import {
  buildVisibleCalendarsRequest,
  mergeServerVisibleCalendars,
  mergeServerVisibleCalendarsWithPending,
  nextPendingVisiblePuts,
} from "./visibleCalendars";

describe("mergeServerVisibleCalendars", () => {
  it("サーバーに configured なエントリはサーバー側の値を採用する", () => {
    const local = { "acc-1": ["local-only"] };
    const server = { "acc-1": ["cal-a", "cal-b"] };
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ "acc-1": ["cal-a", "cal-b"] });
  });

  it("サーバーが空配列 (全部外した意思) でも尊重してローカルの非空値を上書きする", () => {
    const local = { "acc-1": ["cal-a"] };
    const server = { "acc-1": [] };
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ "acc-1": [] });
  });

  it("サーバーに無いアカウント (未設定) はローカルの値をそのまま残す", () => {
    const local = { "acc-1": ["cal-a"], "acc-2": ["cal-b"] };
    const server = { "acc-1": ["cal-a"] };
    expect(mergeServerVisibleCalendars(local, server)).toEqual({
      "acc-1": ["cal-a"],
      "acc-2": ["cal-b"],
    });
  });

  it("ローカルに無いアカウントでもサーバーに configured ならエントリを追加する", () => {
    const local = {};
    const server = { "acc-1": ["cal-a"] };
    expect(mergeServerVisibleCalendars(local, server)).toEqual({ "acc-1": ["cal-a"] });
  });

  it("両方空なら空を返す", () => {
    expect(mergeServerVisibleCalendars({}, {})).toEqual({});
  });

  it("呼び出し順序に依存しない ({ ...local, ...server } と等価)", () => {
    const local = { "acc-1": ["stale"], "acc-2": ["kept"] };
    const server = { "acc-1": ["fresh"] };
    const result = mergeServerVisibleCalendars(local, server);
    expect(result).toEqual({ ...local, ...server });
  });
});

describe("buildVisibleCalendarsRequest", () => {
  it("accountId と calendarIds をそのまま VisibleCalendarsRequest に詰める", () => {
    expect(buildVisibleCalendarsRequest("acc-1", ["cal-a", "cal-b"])).toEqual({
      accountId: "acc-1",
      calendarIds: ["cal-a", "cal-b"],
    });
  });

  it("空配列 (全部外した意思) もそのまま渡す", () => {
    expect(buildVisibleCalendarsRequest("acc-1", [])).toEqual({
      accountId: "acc-1",
      calendarIds: [],
    });
  });
});

describe("nextPendingVisiblePuts", () => {
  it("失敗したら accountId を最新の calendarIds で pending に記録する", () => {
    const pending = new Map<string, string[]>();
    const next = nextPendingVisiblePuts(pending, "acc-1", ["cal-a"], "failure");
    expect(next.get("acc-1")).toEqual(["cal-a"]);
  });

  it("成功したら accountId を pending から消す", () => {
    const pending = new Map([["acc-1", ["cal-a"]]]);
    const next = nextPendingVisiblePuts(pending, "acc-1", ["cal-a"], "success");
    expect(next.has("acc-1")).toBe(false);
  });

  it("同じ accountId が再度失敗したら最新の calendarIds で上書きする(古い値は残らない)", () => {
    const pending = new Map([["acc-1", ["stale"]]]);
    const next = nextPendingVisiblePuts(pending, "acc-1", ["fresh"], "failure");
    expect(next.get("acc-1")).toEqual(["fresh"]);
  });

  it("元の map を破壊しない(不変更新)", () => {
    const pending = new Map<string, string[]>([["acc-1", ["cal-a"]]]);
    nextPendingVisiblePuts(pending, "acc-2", ["cal-b"], "failure");
    expect(pending.has("acc-2")).toBe(false);
  });

  it("無関係な accountId のエントリはそのまま残る", () => {
    const pending = new Map([["acc-1", ["cal-a"]]]);
    const next = nextPendingVisiblePuts(pending, "acc-2", ["cal-b"], "failure");
    expect(next.get("acc-1")).toEqual(["cal-a"]);
    expect(next.get("acc-2")).toEqual(["cal-b"]);
  });
});

describe("mergeServerVisibleCalendarsWithPending", () => {
  it("pending が無ければ mergeServerVisibleCalendars と同じ結果になる(サーバー勝ち)", () => {
    const prev = { "acc-1": ["local-only"] };
    const server = { "acc-1": ["cal-a", "cal-b"] };
    expect(mergeServerVisibleCalendarsWithPending(prev, server, [])).toEqual({
      "acc-1": ["cal-a", "cal-b"],
    });
  });

  it("再送してもなお失敗が残る accountId はサーバー値でなくローカル値 (prev) を保つ", () => {
    const prev = { "acc-1": ["local-fresh"] };
    // サーバーはまだ古い値しか知らない(オフライン中の選択がまだ届いていない)
    const server = { "acc-1": ["server-stale"] };
    const result = mergeServerVisibleCalendarsWithPending(prev, server, ["acc-1"]);
    expect(result).toEqual({ "acc-1": ["local-fresh"] });
  });

  it("pending なアカウントとそうでないアカウントが混在しても、pending 分だけローカル値を保つ", () => {
    const prev = { "acc-1": ["local-fresh"], "acc-2": ["local-2"] };
    const server = { "acc-1": ["server-stale"], "acc-2": ["server-2-updated"] };
    const result = mergeServerVisibleCalendarsWithPending(prev, server, ["acc-1"]);
    expect(result).toEqual({ "acc-1": ["local-fresh"], "acc-2": ["server-2-updated"] });
  });

  it("prev に存在しない accountId が pending に含まれていても安全に無視する", () => {
    const prev = {};
    const server = { "acc-1": ["cal-a"] };
    const result = mergeServerVisibleCalendarsWithPending(prev, server, ["acc-1"]);
    expect(result).toEqual({ "acc-1": ["cal-a"] });
  });
});
