import { createContext, useCallback, useContext } from "react";
import { collectLocationCandidates, type LocationSource } from "../layout/locationSuggestions";
import type { AllDayStore } from "../store/allDayStore";
import type { OccurrenceStore } from "../store/occurrenceStore";

/**
 * 「場所」欄の入力補完 (2026-07-29) の供給側。候補の作り方そのものは純関数
 * (layout/locationSuggestions.ts) で、ここはストアとの配線だけを持つ。
 *
 * **なぜ context か**: 候補を使うのは EventEditForm だが、そこへ至る経路
 * (EventBlock → EventDetailCard / DayColumn の作成ドラフト) はどれも場所とは無関係の
 * コンポーネントで、props を1段ずつ足していくと予定の描画まわり全体に「候補一覧」という
 * 無関係な引数が増える。読み手が1人しかいない値なので context で直接渡す。
 *
 * **なぜ候補そのものではなく関数を配るのか**: 候補一覧を App が state として持つと、
 * ストアの更新 (同期のたびに起きる) を App が購読することになり、アプリ全体が
 * 再レンダーされてしまう。フォームが開いたその瞬間に一度だけ数えれば十分な値なので、
 * 「呼ばれたら数える関数」を配り、EventEditForm がマウント時に1回だけ呼ぶ
 * (呼ばれなければ計算コストはゼロ)。
 */
export type LocationCandidateGetter = () => readonly string[];

/** 未提供 (テストや将来の別マウント) のときは null ―― 呼び出し側は補完なしで動く */
export const LocationCandidatesContext = createContext<LocationCandidateGetter | null>(null);

/** 候補の取得関数を読む。Provider が無ければ null (= 補完を出さない) */
export function useLocationCandidates(): LocationCandidateGetter | null {
  return useContext(LocationCandidatesContext);
}

/**
 * AllDayStore は範囲クエリしか持たない (時刻予定と違い「全件」の読み口が無い) ため、
 * 全ての日付を含む範囲で取り出す。startDate/endDate は YYYY-MM-DD の文字列比較なので、
 * この両端を挟めば必ず全件になる。
 */
const ALL_DATES_FROM = "0000-01-01";
const ALL_DATES_TO = "9999-12-31";

/**
 * 過去の予定から場所の候補を作る関数を返す (App.tsx が Provider の value に渡す)。
 *
 * 供給元は **メモリ上のストア2つだけ**で、IndexedDB は読まない:
 *   - OccurrenceStore: 展開済みウィンドウ (起動時に now±1年、expansion/windowPolicy.ts) の
 *     時刻付き予定。「1年ぶんの自分の予定」はまさに補完で出したい範囲そのもの。
 *   - AllDayStore: 終日予定は展開ウィンドウの概念が無く起動時に全件ロード済み。
 *
 * つまり **追加の I/O は一切発生しない**。表示中の週/月だけに絞らないのは、先月使った
 * 会議室を今日入力したい場面が普通にあるため。逆にウィンドウより古い予定 (IndexedDB には
 * あるがストアには載っていない) をわざわざ読みに行かないのは、1年より前にしか使っていない
 * 場所を補完する価値が低いのに対し、数千件の全件走査 + IndexedDB アクセスは高くつくため。
 *
 * 計算量は「ストアの件数ぶんの1パス」。1年ぶん数千件でも O(n) の文字列正規化1回ずつで、
 * 実測では 1ms 前後 ―― フォームを開くたびに1回だけ走る (下の useCallback は
 * ストアの参照が変わらない限り同一関数なので、EventEditForm 側の useMemo が効く)。
 */
export function useLocationCandidateSource(
  store: OccurrenceStore,
  allDayStore: AllDayStore,
): LocationCandidateGetter {
  return useCallback(() => {
    const sources: LocationSource[] = [];
    for (const occ of store.getAll()) {
      sources.push({ location: occ.location, atMs: occ.startMs });
    }
    for (const allDay of allDayStore.getRange(ALL_DATES_FROM, ALL_DATES_TO)) {
      // 終日予定は時刻を持たないので、並び順のタイブレーク用に開始日を ms へ均す
      // (絶対値ではなく前後関係だけが要るので、UTC 0 時として解釈すれば十分)
      const atMs = Date.parse(allDay.startDate);
      sources.push({ location: allDay.location, atMs: Number.isFinite(atMs) ? atMs : 0 });
    }
    return collectLocationCandidates(sources);
  }, [store, allDayStore]);
}
