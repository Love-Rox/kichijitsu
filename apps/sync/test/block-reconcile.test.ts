import type { GoogleEventDTO } from "@kichijitsu/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  type BlockMirrorRow,
  MIRROR_MARKER_KEY,
  MIRROR_RULE_KEY,
  MIRROR_SOURCE_KEY,
  buildMirrorEventBody,
  indexMirrorsBySourceEvent,
  isMirrorEvent,
  reconcileBlockRule,
} from "../src/core/block-reconcile";

function timedEvent(overrides: Partial<GoogleEventDTO> = {}): GoogleEventDTO {
  return {
    id: "ev-1",
    status: "confirmed",
    start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
    end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    updated: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function mirrorRow(overrides: Partial<BlockMirrorRow> = {}): BlockMirrorRow {
  return {
    rule_id: "rule-1",
    source_event_id: "ev-1",
    mirror_event_id: "mirror-1",
    source_updated: "2026-07-19T00:00:00.000Z",
    created_at: 1000,
    ...overrides,
  };
}

describe("isMirrorEvent", () => {
  it("returns true when the marker is set to '1'", () => {
    const event = timedEvent({
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1" } },
    });
    expect(isMirrorEvent(event)).toBe(true);
  });

  it("returns false when there is no extendedProperties", () => {
    expect(isMirrorEvent(timedEvent())).toBe(false);
  });

  it("returns false when the marker key is absent", () => {
    const event = timedEvent({ extendedProperties: { private: { other: "1" } } });
    expect(isMirrorEvent(event)).toBe(false);
  });

  it("returns false when the marker value is not '1'", () => {
    const event = timedEvent({
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "0" } },
    });
    expect(isMirrorEvent(event)).toBe(false);
  });
});

describe("reconcileBlockRule", () => {
  it("puts a live source with no matching mirror into toCreate", () => {
    const source = timedEvent();
    const plan = reconcileBlockRule([source], []);
    expect(plan.toCreate).toEqual([source]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("puts a source into toPatch when updated differs from the mirror's source_updated", () => {
    const source = timedEvent({ updated: "2026-07-20T00:00:00.000Z" });
    const mirror = mirrorRow({ source_updated: "2026-07-19T00:00:00.000Z" });
    const plan = reconcileBlockRule([source], [mirror]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toPatch).toEqual([{ mirror, source }]);
    expect(plan.toDelete).toEqual([]);
  });

  it("is a no-op when updated matches the mirror's source_updated", () => {
    const source = timedEvent({ updated: "2026-07-19T00:00:00.000Z" });
    const mirror = mirrorRow({ source_updated: "2026-07-19T00:00:00.000Z" });
    const plan = reconcileBlockRule([source], [mirror]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("deletes a mirror whose source has disappeared from the set", () => {
    const mirror = mirrorRow();
    const plan = reconcileBlockRule([], [mirror]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([mirror]);
  });

  it("deletes a mirror whose source is now cancelled", () => {
    const source = timedEvent({ status: "cancelled" });
    const mirror = mirrorRow();
    const plan = reconcileBlockRule([source], [mirror]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([mirror]);
  });

  it("deletes a mirror whose source lost its start/end", () => {
    const source = timedEvent({ start: undefined, end: undefined });
    const mirror = mirrorRow();
    const plan = reconcileBlockRule([source], [mirror]);
    expect(plan.toDelete).toEqual([mirror]);
  });

  it("excludes mirror-marked events from the source set (loop prevention)", () => {
    const genuineSource = timedEvent({ id: "ev-1" });
    const mirrorEvent = timedEvent({
      id: "ev-mirror",
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1" } },
    });
    const plan = reconcileBlockRule([genuineSource, mirrorEvent], []);
    expect(plan.toCreate).toEqual([genuineSource]);
  });

  it("does not create a mirror for a source with no start/end", () => {
    const source = timedEvent({ start: undefined, end: undefined });
    const plan = reconcileBlockRule([source], []);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toPatch).toEqual([]);
    expect(plan.toDelete).toEqual([]);
  });

  it("does not create a mirror for a cancelled source with no existing mirror", () => {
    const source = timedEvent({ status: "cancelled" });
    const plan = reconcileBlockRule([source], []);
    expect(plan.toCreate).toEqual([]);
  });

  it("keeps the first occurrence when the same source id appears twice", () => {
    const first = timedEvent({ id: "ev-1", updated: "2026-07-19T00:00:00.000Z" });
    const duplicate = timedEvent({ id: "ev-1", updated: "2026-07-20T00:00:00.000Z" });
    const plan = reconcileBlockRule([first, duplicate], []);
    expect(plan.toCreate).toEqual([first]);
  });

  it("handles a mix of multiple sources and mirrors: create, patch, delete together", () => {
    const created = timedEvent({ id: "ev-new" });
    const patched = timedEvent({ id: "ev-patched", updated: "2026-07-20T09:00:00.000Z" });
    const untouched = timedEvent({ id: "ev-same", updated: "2026-07-19T00:00:00.000Z" });
    const cancelled = timedEvent({ id: "ev-cancelled", status: "cancelled" });

    const mirrorPatched = mirrorRow({
      source_event_id: "ev-patched",
      mirror_event_id: "mirror-patched",
      source_updated: "2026-07-19T08:00:00.000Z",
    });
    const mirrorUntouched = mirrorRow({
      source_event_id: "ev-same",
      mirror_event_id: "mirror-same",
      source_updated: "2026-07-19T00:00:00.000Z",
    });
    const mirrorCancelled = mirrorRow({
      source_event_id: "ev-cancelled",
      mirror_event_id: "mirror-cancelled",
    });
    const mirrorGone = mirrorRow({
      source_event_id: "ev-gone",
      mirror_event_id: "mirror-gone",
    });

    const plan = reconcileBlockRule(
      [created, patched, untouched, cancelled],
      [mirrorPatched, mirrorUntouched, mirrorCancelled, mirrorGone],
    );

    expect(plan.toCreate).toEqual([created]);
    expect(plan.toPatch).toEqual([{ mirror: mirrorPatched, source: patched }]);
    expect(plan.toDelete).toEqual([mirrorCancelled, mirrorGone]);
  });
});

describe("buildMirrorEventBody", () => {
  it("copies timed start/end as-is", () => {
    const source = timedEvent({
      start: { dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" },
    });
    const body = buildMirrorEventBody(source, "busy", "rule-1");
    expect(body.start).toEqual({ dateTime: "2026-07-20T10:00:00+09:00", timeZone: "Asia/Tokyo" });
    expect(body.end).toEqual({ dateTime: "2026-07-20T11:00:00+09:00", timeZone: "Asia/Tokyo" });
  });

  it("copies all-day start/end as-is", () => {
    const source = timedEvent({
      start: { date: "2026-07-20" },
      end: { date: "2026-07-21" },
    });
    const body = buildMirrorEventBody(source, "busy", "rule-1");
    expect(body.start).toEqual({ date: "2026-07-20" });
    expect(body.end).toEqual({ date: "2026-07-21" });
  });

  it("sets the fixed summary, transparency, and visibility", () => {
    const body = buildMirrorEventBody(timedEvent(), "busy", "rule-1");
    expect(body.summary).toBe("予定あり");
    expect(body.transparency).toBe("opaque");
    expect(body.visibility).toBe("private");
  });

  it("does not set eventType for busy mode", () => {
    const body = buildMirrorEventBody(timedEvent(), "busy", "rule-1");
    expect(body.eventType).toBeUndefined();
  });

  it("sets eventType='outOfOffice' for outOfOffice mode", () => {
    const body = buildMirrorEventBody(timedEvent(), "outOfOffice", "rule-1");
    expect(body.eventType).toBe("outOfOffice");
  });

  it("attaches the mirror marker in extendedProperties.private", () => {
    const body = buildMirrorEventBody(timedEvent(), "busy", "rule-1");
    expect(body.extendedProperties.private[MIRROR_MARKER_KEY]).toBe("1");
  });

  // 対応表 (D1) を失っても Google 側だけで孤児を辿れるようにするための由来 (A-2 の回収経路)。
  it("記録する由来は ID だけ: rule_id と source の id を private プロパティに書く", () => {
    const body = buildMirrorEventBody(timedEvent({ id: "ev-42" }), "busy", "rule-7");
    expect(body.extendedProperties).toEqual({
      private: {
        [MIRROR_MARKER_KEY]: "1",
        [MIRROR_RULE_KEY]: "rule-7",
        [MIRROR_SOURCE_KEY]: "ev-42",
      },
    });
  });

  it("does not copy location, description, or other content fields", () => {
    const source = timedEvent({
      location: "Room 42",
      description: "confidential details",
      summary: "original private title",
    });
    const body = buildMirrorEventBody(source, "busy", "rule-1");
    expect(body).not.toHaveProperty("location");
    expect(body).not.toHaveProperty("description");
    expect(body.summary).toBe("予定あり");
  });
});

/**
 * 孤児ミラーの回収 (block-orchestrate.ts の採用処理) が使う索引。対応表 (D1) が無くても
 * target カレンダーの予定だけで「この source のミラーは既にある」と言えるようにする。
 */
describe("indexMirrorsBySourceEvent", () => {
  /** target カレンダーに実在する mirror 予定。 */
  function mirrorEvent(
    id: string,
    ruleId: string,
    sourceEventId: string,
    overrides: Partial<GoogleEventDTO> = {},
  ): GoogleEventDTO {
    return timedEvent({
      id,
      extendedProperties: {
        private: {
          [MIRROR_MARKER_KEY]: "1",
          [MIRROR_RULE_KEY]: ruleId,
          [MIRROR_SOURCE_KEY]: sourceEventId,
        },
      },
      ...overrides,
    });
  }

  it("このルールの mirror を source id で引ける形にする", () => {
    const index = indexMirrorsBySourceEvent(
      [mirrorEvent("mirror-a", "rule-1", "ev-a"), mirrorEvent("mirror-b", "rule-1", "ev-b")],
      "rule-1",
    );
    expect([...index]).toEqual([
      ["ev-a", "mirror-a"],
      ["ev-b", "mirror-b"],
    ]);
  });

  it("別ルールの mirror は拾わない (横取りして二重管理にしない)", () => {
    const index = indexMirrorsBySourceEvent([mirrorEvent("mirror-x", "rule-2", "ev-a")], "rule-1");
    expect(index.size).toBe(0);
  });

  it("目印の無い普通の予定は拾わない", () => {
    const index = indexMirrorsBySourceEvent([timedEvent({ id: "ev-plain" })], "rule-1");
    expect(index.size).toBe(0);
  });

  it("由来を持たない旧世代の mirror は拾わない", () => {
    const legacy = timedEvent({
      id: "mirror-legacy",
      extendedProperties: { private: { [MIRROR_MARKER_KEY]: "1" } },
    });
    expect(indexMirrorsBySourceEvent([legacy], "rule-1").size).toBe(0);
  });

  it("cancelled の mirror は拾わない (Google 上は既に消えている)", () => {
    const index = indexMirrorsBySourceEvent(
      [mirrorEvent("mirror-gone", "rule-1", "ev-a", { status: "cancelled" })],
      "rule-1",
    );
    expect(index.size).toBe(0);
  });

  it("同じ source に複数あるときは最初の1件を採る", () => {
    const index = indexMirrorsBySourceEvent(
      [mirrorEvent("mirror-first", "rule-1", "ev-a"), mirrorEvent("mirror-second", "rule-1", "ev-a")],
      "rule-1",
    );
    expect(index.get("ev-a")).toBe("mirror-first");
  });
});
