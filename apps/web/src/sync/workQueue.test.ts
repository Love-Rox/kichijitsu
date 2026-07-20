import { describe, expect, it } from "vite-plus/test";
import type { GitHubWorkItemDTO, GitHubWorkKind } from "@kichijitsu/shared";
import { groupWorkItemsByKind, WORK_QUEUE_SECTION_LABELS } from "./workQueue";

function item(overrides: Partial<GitHubWorkItemDTO> = {}): GitHubWorkItemDTO {
  return {
    id: "ghq:acme/repo:issue:1",
    type: "issue",
    kinds: ["assigned"],
    title: "Fix bug",
    repo: "acme/repo",
    number: 1,
    url: "https://github.com/acme/repo/issues/1",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupWorkItemsByKind", () => {
  it("3セクション(review_requested / assigned / authored)を固定順で返す", () => {
    const sections = groupWorkItemsByKind([]);
    expect(sections.map((s) => s.kind)).toEqual(["review_requested", "assigned", "authored"]);
    expect(sections.map((s) => s.label)).toEqual(["レビュー依頼", "自分の担当", "自分の PR"]);
  });

  it("kind ごとに該当する item だけをセクションへ振り分ける", () => {
    const reviewItem = item({ id: "a", kinds: ["review_requested"] });
    const assignedItem = item({ id: "b", kinds: ["assigned"] });
    const authoredItem = item({ id: "c", kinds: ["authored"] });

    const sections = groupWorkItemsByKind([reviewItem, assignedItem, authoredItem]);
    const byKind = new Map(sections.map((s) => [s.kind, s.items]));

    expect(byKind.get("review_requested")).toEqual([reviewItem]);
    expect(byKind.get("assigned")).toEqual([assignedItem]);
    expect(byKind.get("authored")).toEqual([authoredItem]);
  });

  it("複数 kinds を持つ item は該当する全セクションに重複して出す", () => {
    const multi = item({ id: "multi", kinds: ["assigned", "authored"] });

    const sections = groupWorkItemsByKind([multi]);
    const byKind = new Map(sections.map((s) => [s.kind, s.items]));

    expect(byKind.get("review_requested")).toEqual([]);
    expect(byKind.get("assigned")).toEqual([multi]);
    expect(byKind.get("authored")).toEqual([multi]);
  });

  it("該当なしの kind は空配列を返す", () => {
    const sections = groupWorkItemsByKind([item({ kinds: ["assigned"] })]);
    const byKind = new Map(sections.map((s) => [s.kind, s.items]));
    expect(byKind.get("review_requested")).toEqual([]);
    expect(byKind.get("authored")).toEqual([]);
  });

  it("セクション内は updatedAt 降順(新しい順)に並ぶ", () => {
    const old = item({ id: "old", kinds: ["assigned"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const mid = item({ id: "mid", kinds: ["assigned"], updatedAt: "2026-06-01T00:00:00.000Z" });
    const newItem = item({
      id: "new",
      kinds: ["assigned"],
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    const sections = groupWorkItemsByKind([old, newItem, mid]);
    const assignedSection = sections.find((s) => s.kind === "assigned")!;

    expect(assignedSection.items.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  it("入力配列を変更しない(非破壊)", () => {
    const items = [
      item({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "b", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    const snapshot = [...items];

    groupWorkItemsByKind(items);

    expect(items).toEqual(snapshot);
  });

  it("空配列を渡せば各セクションとも空配列になる", () => {
    const sections = groupWorkItemsByKind([]);
    for (const s of sections) {
      expect(s.items).toEqual([]);
    }
  });

  it("WORK_QUEUE_SECTION_LABELS が全 kind をカバーする", () => {
    const kinds: GitHubWorkKind[] = ["review_requested", "assigned", "authored"];
    for (const k of kinds) {
      expect(WORK_QUEUE_SECTION_LABELS[k]).toBeTruthy();
    }
  });
});
