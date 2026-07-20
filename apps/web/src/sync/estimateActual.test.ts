import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CAP_MS,
  DEFAULT_GAP_MS,
  DEFAULT_LEAD_IN_MS,
  clusterCommitSessions,
  collectPrTargets,
  estimateActualMs,
  estimateByItemKey,
  estimateSessionMs,
  reportItemKey,
} from "./estimateActual";

const MIN = 60_000;
const HOUR = 3_600_000;

describe("clusterCommitSessions", () => {
  it("空配列なら空配列", () => {
    expect(clusterCommitSessions([], 90 * MIN)).toEqual([]);
  });

  it("単一 commit は1セッション1件", () => {
    expect(clusterCommitSessions([1000], 90 * MIN)).toEqual([[1000]]);
  });

  it("間隔が gapMs ちょうどなら同一セッション", () => {
    const t0 = 0;
    const t1 = 90 * MIN;
    expect(clusterCommitSessions([t0, t1], 90 * MIN)).toEqual([[t0, t1]]);
  });

  it("間隔が gapMs を1msでも超えたら別セッションに分割する", () => {
    const t0 = 0;
    const t1 = 90 * MIN + 1;
    expect(clusterCommitSessions([t0, t1], 90 * MIN)).toEqual([[t0], [t1]]);
  });

  it("順不同の入力を昇順ソートしてからクラスタリングする", () => {
    const t0 = 0;
    const t1 = 10 * MIN;
    const t2 = 200 * MIN;
    expect(clusterCommitSessions([t2, t0, t1], 90 * MIN)).toEqual([[t0, t1], [t2]]);
  });

  it("3件以上でも間隔ごとに正しく分割する", () => {
    const t0 = 0;
    const t1 = 10 * MIN; // 同一セッション(間隔10分)
    const t2 = t1 + 100 * MIN; // 別セッション(間隔100分 > 90分)
    const t3 = t2 + 5 * MIN; // 同一セッション(間隔5分)
    expect(clusterCommitSessions([t0, t1, t2, t3], 90 * MIN)).toEqual([
      [t0, t1],
      [t2, t3],
    ]);
  });
});

describe("estimateSessionMs", () => {
  it("単一 commit のセッションは leadInMs のみ", () => {
    expect(estimateSessionMs([1000], { leadInMs: 30 * MIN, capMs: 8 * HOUR })).toBe(30 * MIN);
  });

  it("複数 commit は (最後-最初) + leadInMs", () => {
    const session = [0, 20 * MIN, 45 * MIN];
    expect(estimateSessionMs(session, { leadInMs: 30 * MIN, capMs: 8 * HOUR })).toBe(
      45 * MIN + 30 * MIN,
    );
  });

  it("順不同の session でも min/max を取って計算する", () => {
    const session = [45 * MIN, 0, 20 * MIN];
    expect(estimateSessionMs(session, { leadInMs: 30 * MIN, capMs: 8 * HOUR })).toBe(
      45 * MIN + 30 * MIN,
    );
  });

  it("capMs を超える見積もりは capMs にクランプする", () => {
    const session = [0, 20 * HOUR];
    expect(estimateSessionMs(session, { leadInMs: 30 * MIN, capMs: 8 * HOUR })).toBe(8 * HOUR);
  });

  it("空配列は0", () => {
    expect(estimateSessionMs([], { leadInMs: 30 * MIN, capMs: 8 * HOUR })).toBe(0);
  });
});

describe("estimateActualMs", () => {
  it("空配列は0", () => {
    expect(estimateActualMs([])).toBe(0);
  });

  it("既定値(gap90分/leadIn30分/cap8時間)で単一セッションを見積もる", () => {
    const t0 = 0;
    const t1 = 45 * MIN;
    expect(estimateActualMs([t0, t1])).toBe(45 * MIN + DEFAULT_LEAD_IN_MS);
  });

  it("複数セッションに分割されたら各セッションの見積もりを合計する", () => {
    const session1 = [0, 20 * MIN];
    const session2Start = 20 * MIN + DEFAULT_GAP_MS + MIN; // gap を超えて別セッション
    const session2 = [session2Start, session2Start + 10 * MIN];
    const expected =
      estimateSessionMs(session1, { leadInMs: DEFAULT_LEAD_IN_MS, capMs: DEFAULT_CAP_MS }) +
      estimateSessionMs(session2, { leadInMs: DEFAULT_LEAD_IN_MS, capMs: DEFAULT_CAP_MS });
    expect(estimateActualMs([...session1, ...session2])).toBe(expected);
  });

  it("カスタムオプションを渡せる", () => {
    const t0 = 0;
    const t1 = 5 * MIN;
    expect(estimateActualMs([t0, t1], { gapMs: 10 * MIN, leadInMs: MIN, capMs: HOUR })).toBe(
      5 * MIN + MIN,
    );
  });

  it("単一 commit なら leadInMs のみ(既定30分)", () => {
    expect(estimateActualMs([12345])).toBe(DEFAULT_LEAD_IN_MS);
  });
});

describe("estimateByItemKey", () => {
  it("空オブジェクトは空オブジェクト", () => {
    expect(estimateByItemKey({})).toEqual({});
  });

  it("ISO タイムスタンプをキーごとに ms へ変換して見積もる", () => {
    const commitsByItem = {
      "owner/repo#1": ["2026-07-20T09:00:00.000Z", "2026-07-20T09:45:00.000Z"],
      "owner/repo#2": ["2026-07-20T10:00:00.000Z"],
    };
    const result = estimateByItemKey(commitsByItem);
    expect(result["owner/repo#1"]).toBe(45 * MIN + DEFAULT_LEAD_IN_MS);
    expect(result["owner/repo#2"]).toBe(DEFAULT_LEAD_IN_MS);
  });

  it("空配列のキーは0", () => {
    expect(estimateByItemKey({ "owner/repo#1": [] })).toEqual({ "owner/repo#1": 0 });
  });

  it("不正な ISO 文字列は無視する", () => {
    const result = estimateByItemKey({
      "owner/repo#1": ["not-a-date", "2026-07-20T09:00:00.000Z"],
    });
    expect(result["owner/repo#1"]).toBe(DEFAULT_LEAD_IN_MS);
  });

  it("オプションを渡すと各キーに適用される", () => {
    const result = estimateByItemKey(
      { "owner/repo#1": ["2026-07-20T09:00:00.000Z", "2026-07-20T09:05:00.000Z"] },
      { gapMs: 10 * MIN, leadInMs: MIN, capMs: HOUR },
    );
    expect(result["owner/repo#1"]).toBe(5 * MIN + MIN);
  });
});

describe("reportItemKey", () => {
  it("owner/repo#number 形式のキーを組み立てる", () => {
    expect(reportItemKey({ repo: "owner/repo", number: 42 })).toBe("owner/repo#42");
  });
});

describe("collectPrTargets", () => {
  function item(itemType: "issue" | "pr", repo: string, number: number) {
    return { itemType, repo, number };
  }

  it("空配列なら空配列", () => {
    expect(collectPrTargets([], [])).toEqual([]);
  });

  it("issue は除外し PR のみ集める", () => {
    const planned = [item("issue", "owner/repo", 1), item("pr", "owner/repo", 2)];
    const entries = [item("issue", "owner/repo", 3)];
    expect(collectPrTargets(planned, entries)).toEqual([{ repo: "owner/repo", number: 2 }]);
  });

  it("plannedBlocks と timeEntries の両方から集め、重複を除く", () => {
    const planned = [item("pr", "owner/repo", 1)];
    const entries = [item("pr", "owner/repo", 1), item("pr", "owner/repo", 2)];
    expect(collectPrTargets(planned, entries)).toEqual([
      { repo: "owner/repo", number: 1 },
      { repo: "owner/repo", number: 2 },
    ]);
  });
});
