import { describe, expect, it } from "vite-plus/test";
import { isSnapDisabledDuringDrag, resolveDragIntent, type DragIntent } from "./dragDuplicate";

/** マウスでの pointerdown を短く書くためのヘルパ(複製可能な予定を掴んだ想定) */
function intentOnMouseDown(altKey: boolean, canDuplicate = true): DragIntent {
  return resolveDragIntent({ pointerType: "mouse", altKey, canDuplicate });
}

describe("resolveDragIntent", () => {
  it("pointerdown で Option を押していたら複製", () => {
    expect(intentOnMouseDown(true)).toBe("duplicate");
  });

  it("pointerdown で Option を押していなければ移動", () => {
    expect(intentOnMouseDown(false)).toBe("move");
  });

  it("複製できない予定(ミラー・Busy・他人のカレンダー等)は Option を押していても移動", () => {
    expect(intentOnMouseDown(true, false)).toBe("move");
  });

  it("タッチには修飾キーが無いので複製は起きない(タップ選択→ドラッグ移動の既存挙動を守る)", () => {
    // 実ブラウザではタッチの altKey は常に false だが、万一 true で来ても move に倒す
    expect(resolveDragIntent({ pointerType: "touch", altKey: true, canDuplicate: true })).toBe(
      "move",
    );
    expect(resolveDragIntent({ pointerType: "touch", altKey: false, canDuplicate: true })).toBe(
      "move",
    );
  });

  it("ペン(pointerType='pen')はマウスと同じ扱い", () => {
    expect(resolveDragIntent({ pointerType: "pen", altKey: true, canDuplicate: true })).toBe(
      "duplicate",
    );
  });
});

describe("isSnapDisabledDuringDrag", () => {
  it("移動ドラッグ中に Option を押すと、従来どおりスナップが外れる", () => {
    const intent = intentOnMouseDown(false); // 開始時は Option 無し = 移動
    expect(isSnapDisabledDuringDrag({ intent, altKey: false })).toBe(false);
    // ドラッグの途中で押した瞬間から1分単位になる
    expect(isSnapDisabledDuringDrag({ intent, altKey: true })).toBe(true);
    // 離せばまた 15分スナップに戻る
    expect(isSnapDisabledDuringDrag({ intent, altKey: false })).toBe(false);
  });

  it("複製ドラッグ中は Option を押し続けていても 15分スナップが効いたまま", () => {
    const intent = intentOnMouseDown(true); // 開始時に Option = 複製
    expect(isSnapDisabledDuringDrag({ intent, altKey: true })).toBe(false);
    expect(isSnapDisabledDuringDrag({ intent, altKey: false })).toBe(false);
  });
});

describe("ドラッグ1回ぶんの意味は pointerdown で決まり、途中で変わらない", () => {
  it("Option ありで開始 → 途中で離しても複製のまま", () => {
    // intent は pointerdown で1度だけ決めて DragState に持つ設計(EventBlock.tsx)。
    // 「離したら移動に戻る」ような再判定はしない ―― この2行がその仕様そのもの。
    const intent = intentOnMouseDown(true);
    expect(intent).toBe("duplicate");
    // pointerup 時に altKey が false でも intent は duplicate を指したまま
    expect(isSnapDisabledDuringDrag({ intent, altKey: false })).toBe(false);
  });

  it("Option なしで開始 → 途中で押しても移動のまま(複製にはならない)", () => {
    const intent = intentOnMouseDown(false);
    expect(intent).toBe("move");
    // 途中で押した Option はスナップ解除としてだけ働く
    expect(isSnapDisabledDuringDrag({ intent, altKey: true })).toBe(true);
  });
});
