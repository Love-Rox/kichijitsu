import { describe, expect, it } from "vite-plus/test";
import { buildReportRows, reportRowsToCsv } from "./reportExport";
import type { PlannedBlock, TimeEntry } from "../model/types";
import type { WorkLogDTO } from "@kichijitsu/shared";

let workLogSeq = 0;

function planned(
  linkedItemId: string,
  startMs: number,
  endMs: number,
  overrides: Partial<PlannedBlock> = {},
): PlannedBlock {
  return {
    id: `plan:${linkedItemId}:${startMs}`,
    startMs,
    endMs,
    linkedItemId,
    itemType: "issue",
    title: "予定タイトル",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    ...overrides,
  };
}

function entry(
  linkedItemId: string,
  startMs: number,
  endMs: number | null,
  overrides: Partial<TimeEntry> = {},
): TimeEntry {
  return {
    id: `te:${linkedItemId}:${startMs}`,
    linkedItemId,
    itemType: "issue",
    title: "実績タイトル",
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/issues/1",
    startMs,
    endMs,
    ...overrides,
  };
}

function workLog(overrides: Partial<WorkLogDTO> & { repo: string }): WorkLogDTO {
  workLogSeq += 1;
  return {
    id: `work-log-${workLogSeq}`,
    startMs: 0,
    endMs: 3_600_000,
    ...overrides,
  };
}

describe("buildReportRows", () => {
  it("予定/実績(手動)は aggregatePlannedVsActual と同じ内容になる", () => {
    const blocks = [planned("a", 0, 60 * 60_000)];
    const entries = [entry("a", 0, 30 * 60_000)];
    const rows = buildReportRows(
      { plannedBlocks: blocks, timeEntries: entries, workLogs: [], estimatesByKey: {} },
      0,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].linkedItemId).toBe("a");
    expect(rows[0].plannedMs).toBe(60 * 60_000);
    expect(rows[0].actualMs).toBe(30 * 60_000);
  });

  it("hook 実績を linkedItemId で突き合わせてマージする", () => {
    const blocks = [
      planned("ghq:owner/repo:issue:42", 0, 60 * 60_000, { itemType: "issue", number: 42 }),
    ];
    const workLogs = [
      workLog({ repo: "owner/repo", issueRef: "42", startMs: 0, endMs: 1_800_000 }),
    ];
    const rows = buildReportRows(
      { plannedBlocks: blocks, timeEntries: [], workLogs, estimatesByKey: {} },
      0,
    );

    expect(rows[0].hookActualMs).toBe(1_800_000);
  });

  it("hook 実績が一致しない行は hookActualMs が undefined", () => {
    const blocks = [planned("ghq:owner/repo:issue:1", 0, 60 * 60_000, { number: 1 })];
    const rows = buildReportRows(
      { plannedBlocks: blocks, timeEntries: [], workLogs: [], estimatesByKey: {} },
      0,
    );

    expect(rows[0].hookActualMs).toBeUndefined();
  });

  it("PR 行は estimatesByKey を reportItemKey (`repo#number`) で突き合わせる", () => {
    const blocks = [planned("ghq:owner/repo:pr:7", 0, 60 * 60_000, { itemType: "pr", number: 7 })];
    const rows = buildReportRows(
      {
        plannedBlocks: blocks,
        timeEntries: [],
        workLogs: [],
        estimatesByKey: { "owner/repo#7": 5_400_000 },
      },
      0,
    );

    expect(rows[0].estimateMs).toBe(5_400_000);
  });

  it("issue 行は estimatesByKey に一致するキーがあっても estimateMs は常に undefined", () => {
    const blocks = [
      planned("ghq:owner/repo:issue:7", 0, 60 * 60_000, { itemType: "issue", number: 7 }),
    ];
    const rows = buildReportRows(
      {
        plannedBlocks: blocks,
        timeEntries: [],
        workLogs: [],
        estimatesByKey: { "owner/repo#7": 5_400_000 },
      },
      0,
    );

    expect(rows[0].estimateMs).toBeUndefined();
  });

  it("同じ repo+number の issue と pr が両方あれば hook 実績は両方に加算される", () => {
    const blocks = [
      planned("ghq:owner/repo:issue:5", 0, 60 * 60_000, { itemType: "issue", number: 5 }),
      planned("ghq:owner/repo:pr:5", 0, 60 * 60_000, { itemType: "pr", number: 5 }),
    ];
    const workLogs = [workLog({ repo: "owner/repo", issueRef: "5", startMs: 0, endMs: 3_600_000 })];
    const rows = buildReportRows(
      { plannedBlocks: blocks, timeEntries: [], workLogs, estimatesByKey: {} },
      0,
    );

    for (const row of rows) {
      expect(row.hookActualMs).toBe(3_600_000);
    }
  });

  it("予定だけ/実績だけの item も行として含める(aggregatePlannedVsActual と同じ網羅性)", () => {
    const blocks = [planned("planned-only", 0, 60 * 60_000)];
    const entries = [entry("actual-only", 0, 30 * 60_000)];
    const rows = buildReportRows(
      { plannedBlocks: blocks, timeEntries: entries, workLogs: [], estimatesByKey: {} },
      0,
    );

    expect(rows.map((r) => r.linkedItemId).sort()).toEqual(["actual-only", "planned-only"]);
  });

  it("空入力なら空配列", () => {
    expect(
      buildReportRows({ plannedBlocks: [], timeEntries: [], workLogs: [], estimatesByKey: {} }, 0),
    ).toEqual([]);
  });
});

describe("reportRowsToCsv", () => {
  it("空配列ならヘッダーのみの1行を返す", () => {
    const csv = reportRowsToCsv([]);
    expect(csv).toBe(
      "repo,number,type,title,planned_min,actual_manual_min,actual_hook_min,estimate_min",
    );
  });

  it("複数行を分単位・undefined は空セルで出力する", () => {
    const rows = buildReportRows(
      {
        plannedBlocks: [
          planned("ghq:owner/repo:issue:1", 0, 90 * 60_000, { itemType: "issue", number: 1 }),
        ],
        timeEntries: [
          entry("ghq:owner/repo:issue:1", 0, 30 * 60_000, { itemType: "issue", number: 1 }),
        ],
        workLogs: [],
        estimatesByKey: {},
      },
      0,
    );
    const csv = reportRowsToCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("owner/repo,1,issue,予定タイトル,90,30,,");
  });

  it("title にカンマ・引用符・改行があれば RFC4180 準拠でクォートする", () => {
    const rows = buildReportRows(
      {
        plannedBlocks: [
          planned("a", 0, 60_000, {
            title: 'カンマ,と"引用符"と\n改行',
            repo: "owner/repo",
            number: 1,
          }),
        ],
        timeEntries: [],
        workLogs: [],
        estimatesByKey: {},
      },
      0,
    );
    const csv = reportRowsToCsv(rows);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toBe('owner/repo,1,issue,"カンマ,と""引用符""と\n改行",1,0,,');
  });

  it("repo にカンマが含まれてもクォートする", () => {
    const rows = buildReportRows(
      {
        plannedBlocks: [planned("a", 0, 60_000, { repo: "owner,repo", number: 1 })],
        timeEntries: [],
        workLogs: [],
        estimatesByKey: {},
      },
      0,
    );
    const csv = reportRowsToCsv(rows);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine.startsWith('"owner,repo",1,')).toBe(true);
  });

  it("hook 実績・推定が両方揃っている行は分単位で出力する", () => {
    const rows = buildReportRows(
      {
        plannedBlocks: [
          planned("ghq:owner/repo:pr:7", 0, 60 * 60_000, { itemType: "pr", number: 7 }),
        ],
        timeEntries: [],
        workLogs: [workLog({ repo: "owner/repo", issueRef: "7", startMs: 0, endMs: 1_800_000 })],
        estimatesByKey: { "owner/repo#7": 5_400_000 },
      },
      0,
    );
    const csv = reportRowsToCsv(rows);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toBe("owner/repo,7,pr,予定タイトル,60,0,30,90");
  });
});
