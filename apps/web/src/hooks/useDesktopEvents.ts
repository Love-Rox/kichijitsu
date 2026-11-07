/**
 * デスクトップ版(Tauri)からの合図を受ける (2026-11-07)。
 *
 * Rust 側(apps/desktop/src-tauri/src/lib.rs の dispatch_web_event)が、window に
 * `kichijitsu-desktop` という CustomEvent を送る。detail は Rust が定数と整数だけから作った
 * オブジェクトで、種類は次の 2 つ:
 *  - `{ kind: "quickCreate" }`: 「予定を作る」のグローバルショートカット。作成フォームを開く
 *  - `{ kind: "focusEvent", startMs }`: トレイの「今日の予定」を押した。その予定の日へ移る
 * ブラウザ/PWA では、このイベントは来ない(何も起きない)。
 *
 * 外から来た値は、形を確かめてから使う(startMs は有限の数であること)。
 */
import { useEffect } from "react";

export interface DesktopEventHandlers {
  onQuickCreate: () => void;
  onFocusEvent: (startMs: number) => void;
}

/** detail の形を確かめて、扱える合図だけを返す(純関数、テスト用に分けてある) */
export function parseDesktopEvent(
  detail: unknown,
): { kind: "quickCreate" } | { kind: "focusEvent"; startMs: number } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { kind?: unknown; startMs?: unknown };
  if (d.kind === "quickCreate") return { kind: "quickCreate" };
  if (d.kind === "focusEvent" && typeof d.startMs === "number" && Number.isFinite(d.startMs)) {
    return { kind: "focusEvent", startMs: d.startMs };
  }
  return null;
}

export function useDesktopEvents({ onQuickCreate, onFocusEvent }: DesktopEventHandlers): void {
  useEffect(() => {
    const listener = (e: Event) => {
      const event = parseDesktopEvent((e as CustomEvent).detail);
      if (!event) return;
      if (event.kind === "quickCreate") onQuickCreate();
      else onFocusEvent(event.startMs);
    };
    window.addEventListener("kichijitsu-desktop", listener);
    return () => window.removeEventListener("kichijitsu-desktop", listener);
  }, [onQuickCreate, onFocusEvent]);
}
