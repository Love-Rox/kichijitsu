import { useEffect, useState } from "react";

/**
 * window.matchMedia が返す MediaQueryList のうち、このフックが使う最小限の形
 * (useServerEvents.ts の EventSourceLike と同じ流儀: jsdom を追加せずに配線ロジックだけを
 * ユニットテストできるようにするための最小インターフェース)。
 */
export interface MediaQueryListLike {
  matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

/**
 * mql の現在値を setMatches へ即座に反映しつつ、以後の 'change' もそのまま流し込む購読を張る。
 * React (useEffect) から独立させてあるのは、jsdom を追加せずこの配線ロジックだけを
 * フェイクの MediaQueryListLike でユニットテストできるようにするため
 * (useMediaQuery.test.ts 参照)。戻り値は購読解除関数。
 */
export function subscribeMediaQuery(
  mql: MediaQueryListLike,
  setMatches: (matches: boolean) => void,
): () => void {
  setMatches(mql.matches);
  function handleChange(event: { matches: boolean }): void {
    setMatches(event.matches);
  }
  mql.addEventListener("change", handleChange);
  return () => mql.removeEventListener("change", handleChange);
}

/**
 * モバイル対応フェーズ2(docs/multiplatform.md)。CSS の @media と同じ query 文字列を
 * matchMedia で購読し、真偽値として返す React フック。App.tsx はこれで
 * `(max-width: 640px)` を判定し、狭幅では既定ビューを day3(3日タイムライン)にする。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => subscribeMediaQuery(window.matchMedia(query), setMatches), [query]);

  return matches;
}
