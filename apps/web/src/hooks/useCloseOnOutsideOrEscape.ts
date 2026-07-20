import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * ポップオーバー/カード系 UI の共通の「開いている間: 外側クリック・Escape で閉じる」挙動。
 * EventBlock の詳細ポップオーバーと AllDayBar の詳細ポップオーバー(フェーズ5)の
 * 両方から使う(元は EventBlock.tsx にだけあった useEffect を切り出したもの)。
 *
 * active が false の間は何もしない(ポップオーバーが閉じている間はリスナーを張らない)。
 */
export function useCloseOnOutsideOrEscape(
  active: boolean,
  cardRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    function onPointerDownOutside(e: PointerEvent) {
      const card = cardRef.current;
      if (card && !card.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDownOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
