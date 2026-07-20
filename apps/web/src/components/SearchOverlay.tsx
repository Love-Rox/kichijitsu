import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { IDBPDatabase } from "idb";
import type { KichijitsuDB } from "../db/database";
import { getAllAllDayOccurrences, getAllOccurrences } from "../db/database";
import {
  searchOccurrences,
  type SearchJumpTarget,
  type SearchResultItem,
} from "../search/searchOccurrences";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { formatAllDayDateRange, formatDetailDateTime } from "../layout/gridMetrics";
import { resolveDisplayColor } from "../layout/eventColors";
import type { CalendarInfo } from "./EventBlock";
import "./SearchOverlay.css";

/** クエリのデバウンス。全件を対象にした部分一致検索を1文字ごとに走らせないための猶予 */
const DEBOUNCE_MS = 200;

export interface SearchOverlayProps {
  onClose: () => void;
  /** 初期化前 (db===null) はマウントされていても「読み込み中」表示のみ */
  db: IDBPDatabase<KichijitsuDB> | null;
  timeZone: string;
  /** WeekGrid/MonthView と同じ規則(ローカルは常時対象、Google は選択中カレンダーのみ)でフィルタする */
  visibleCalendarKeys: Set<string>;
  calendarLookup: Map<string, CalendarInfo>;
  onJump: (target: SearchJumpTarget) => void;
}

/**
 * 予定検索オーバーレイ(フェーズ6)。ツールバーの検索ボタンから開く画面上部中央のモーダル風 UI。
 * KeyboardHelpOverlay/CalendarSettingsPanel と同じ役割分担: 開閉制御は App.tsx が
 * `{searchOpen && <SearchOverlay .../>}` で担い、このコンポーネントは常に「開いている」
 * 前提でマウントされる(閉じたらアンマウントされ、次に開いたときは新規状態で始まる)。
 *
 * 検索対象は IndexedDB の全件(store は展開ウィンドウ内のみのため使えない) — マウント時に
 * getAllOccurrences/getAllAllDayOccurrences で読み込み、以降はクエリ変更のたびに(デバウンス後)
 * クライアント側でメモリ上のスナップショットを再フィルタするだけにして DB アクセスを避ける。
 */
export function SearchOverlay({
  onClose,
  db,
  timeZone,
  visibleCalendarKeys,
  calendarLookup,
  onJump,
}: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [snapshot, setSnapshot] = useState<{
    occurrences: Awaited<ReturnType<typeof getAllOccurrences>>;
    allDay: Awaited<ReturnType<typeof getAllAllDayOccurrences>>;
  } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useCloseOnOutsideOrEscape(true, cardRef, onClose);

  // マウント時に一度だけ: DB から全件スナップショットを読み込み、入力欄へフォーカスする
  useEffect(() => {
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0);
    if (!db) return () => window.clearTimeout(focusTimer);
    let cancelled = false;
    Promise.all([getAllOccurrences(db), getAllAllDayOccurrences(db)])
      .then(([occurrences, allDay]) => {
        if (!cancelled) setSnapshot({ occurrences, allDay });
      })
      .catch((err) => {
        console.error("kichijitsu: search overlay failed to load occurrences", err);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  // クエリ変更のデバウンス(200ms) — 全件対象の部分一致を1タイプごとに再計算しないため
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  const results = useMemo<SearchResultItem[]>(() => {
    if (!snapshot) return [];
    return searchOccurrences(debouncedQuery, snapshot.occurrences, snapshot.allDay, {
      visibleCalendarKeys,
    });
  }, [snapshot, debouncedQuery, visibleCalendarKeys]);

  // 結果件数が変わって選択位置がはみ出したら丸める
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  function jumpTo(item: SearchResultItem) {
    onJump(
      item.kind === "timed"
        ? { kind: "timed", startMs: item.occurrence.startMs }
        : { kind: "allDay", startDate: item.occurrence.startDate },
    );
    onClose();
  }

  function handleInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[selectedIndex];
      if (item) jumpTo(item);
    }
    // Escape は useCloseOnOutsideOrEscape の document キーリスナーが拾うのでここでは扱わない
  }

  return createPortal(
    <div className="search-overlay-backdrop">
      <div className="search-overlay" ref={cardRef} role="dialog" aria-label="予定検索">
        <input
          ref={inputRef}
          type="text"
          className="search-overlay-input"
          placeholder="予定を検索(タイトル・場所・説明)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          aria-label="予定を検索"
        />
        <div className="search-overlay-results" role="listbox">
          {!snapshot ? (
            <div className="search-overlay-empty">読み込み中…</div>
          ) : results.length === 0 ? (
            <div className="search-overlay-empty">該当なし</div>
          ) : (
            results.map((item, i) => (
              <SearchResultRow
                key={item.occurrence.id}
                item={item}
                active={i === selectedIndex}
                timeZone={timeZone}
                calendarLookup={calendarLookup}
                onPick={() => jumpTo(item)}
                onHover={() => setSelectedIndex(i)}
              />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface SearchResultRowProps {
  item: SearchResultItem;
  active: boolean;
  timeZone: string;
  calendarLookup: Map<string, CalendarInfo>;
  onPick: () => void;
  onHover: () => void;
}

/** 結果1行: カレンダー色ドット・日時・タイトル・場所(あれば)。行全体がクリック可能 */
function SearchResultRow({
  item,
  active,
  timeZone,
  calendarLookup,
  onPick,
  onHover,
}: SearchResultRowProps) {
  const o = item.occurrence;
  const dateTimeLabel =
    item.kind === "timed"
      ? formatDetailDateTime(item.occurrence.startMs, item.occurrence.endMs, timeZone)
      : formatAllDayDateRange(item.occurrence.startDate, item.occurrence.endDate);
  const color = resolveDisplayColor(o, calendarLookup);

  return (
    <button
      type="button"
      className={active ? "search-result-row is-active" : "search-result-row"}
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <span className="search-result-dot" style={{ background: color }} aria-hidden="true" />
      <span className="search-result-main">
        <span className="search-result-title">{o.title || "(無題)"}</span>
        <span className="search-result-meta">
          {dateTimeLabel}
          {o.location ? ` ・ ${o.location}` : ""}
        </span>
      </span>
    </button>
  );
}
