/**
 * 「場所」欄の入力補完 (2026-07-29)。
 *
 * 候補は **手元のデータ (過去の予定の location) だけ**から作る。外部の場所検索
 * (Google Places 等) は使わない ―― 実際に入力したい場所は「会議室A」「西ヶ原四丁目治療院」の
 * ように *自分が過去に使った場所* がほとんどで、手元のデータで足りるうえ、API キーの管理と
 * 外部通信が増えないため。
 *
 * DOM/React に依存しない純関数のみをここに置く (layout/ の流儀、meetingLinks.ts と同じ)。
 * 供給元 (どのストアから何件読むか) は hooks/useLocationSuggestions.ts、
 * 見せ方 (datalist) は components/EventEditForm.tsx の責務。
 */

/**
 * 候補の元になる1件。Occurrence (時刻あり) と AllDayOccurrence (終日) の両方を
 * 同じ形で渡せるよう、必要な2フィールドだけに絞ってある。
 */
export interface LocationSource {
  location?: string;
  /** 並び順のタイブレーク (最近使った順) に使う時刻。終日予定は開始日の 0 時でよい */
  atMs: number;
}

/**
 * 候補プールの上限。頻度順の上位からこの件数までを保持する。
 *
 * 200 にしてあるのは「1年ぶん数千件の予定でも、実際に現れる場所の種類はせいぜい数十」
 * という実データの感触に対して十分な余裕を取りつつ、絞り込みが常に定数時間で終わるように
 * するため。上限で切り落とされるのは「1回しか使っていない古い場所」から順になる。
 */
export const MAX_LOCATION_CANDIDATES = 200;

/**
 * 一度に見せる候補の上限。プール (200件) をそのまま <datalist> に流し込むと、入力の
 * 1文字ごとに数百個の <option> を作り直すことになるうえ、ブラウザのドロップダウンも
 * 長大になって選びにくい。20件あれば実用上は十分に届く。
 */
export const MAX_LOCATION_SUGGESTIONS = 20;

/**
 * 候補として扱う location の最大文字数。これを超えるものは住所や会議室名ではなく、
 * 案内文・注意書きが丸ごと貼られたもの ―― 補完で選びたい対象ではないので候補から外す。
 */
const MAX_LOCATION_LENGTH = 120;

/**
 * 表示用に整えた文字列。前後の空白を落とし、連続する空白 (全角スペース U+3000 を含む。
 * JS の `\s` は U+3000 にもマッチする) を半角スペース1つに畳む。
 * **表記そのものは変えない** ―― 大文字小文字や全角/半角は利用者が選んだ書き方なので、
 * 候補として画面に出すときはそのまま尊重する (揃えるのは下の同一視キーの側だけ)。
 */
export function normalizeLocation(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * 「同じ場所」とみなすためのキー。同じ場所が表記違いで別候補として並ぶと、補完の
 * 一覧が似た行だらけになって選べなくなるため、次の揺れを吸収する:
 *
 *   - **NFKC 正規化**: 全角/半角の揺れ (`会議室Ａ` と `会議室A`、半角カナ `ｶﾌｪ` と `カフェ`)。
 *     ブラウザ/IME/Google カレンダーのどれ経由で入ったかで簡単に混ざる。
 *   - **小文字化**: `Zoom` と `zoom`、`Room A` と `room a`。
 *   - **空白の除去**: `会議室 A` と `会議室A`。日本語では語の区切りに空白を入れるかどうかが
 *     完全に書き手の気分なので、畳むのではなく落としてしまう方が実データによく合う。
 *
 * 表示に使う表記は collectLocationCandidates が多数決で選ぶので、ここで潰した情報が
 * そのまま画面に出ることはない。
 */
export function locationDedupeKey(raw: string): string {
  return normalizeLocation(raw).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/**
 * その location を補完の候補にしてよいか。
 *
 * **URL は候補にしない。** location に URL が入っている予定は実データにも多い
 * (`https://app.slack.com/huddle/...`、Zoom/Meet の URL) が、これらは
 * layout/meetingLinks.ts の resolveMeetingUrl が「会議に参加するリンク」として扱い、
 * UI でも生 URL ではなく会議アイコンとして描かれている ―― *場所の名前ではない*。
 * しかもハドル/ミーティング URL は会議ごとに異なる使い捨ての値で、利用者が手で打ち直したい
 * ものではない (打ち直すと別の会議に繋がってしまう)。会議リンクは Google 側や
 * Slack 側が予定に付けるものなので、補完で入力を助ける価値もない。
 *
 * 判定は「URL として解釈できるか」ではなく **`http://` / `https://` を含むか** で行う。
 * `オンライン (https://zoom.us/j/...)` のように前後に説明が付いた形も実在し、これも
 * 使い捨ての URL を含む以上そのまま再入力させたい文字列ではないため。
 */
export function isSuggestableLocation(raw: string | undefined): boolean {
  const display = normalizeLocation(raw ?? "");
  if (display.length === 0) return false;
  if (display.length > MAX_LOCATION_LENGTH) return false;
  return !/https?:\/\//i.test(display);
}

/** 同一視キーごとの集計。display は表記揺れの候補と、その出現回数/最終使用時刻 */
interface Bucket {
  count: number;
  lastMs: number;
  displays: Map<string, { count: number; lastMs: number }>;
}

/**
 * 過去の予定から場所の候補を作る。
 *
 * **並び順は「使用回数の多い順 → 最近使った順 → 文字列順」。** 回数を主にしたのは、
 * 補完で一番出したいのが「毎週の定例で使う会議室」のような常用の場所だからで、
 * 最近使った順を主にすると、一度きりの外出先が上位を占めて常用の場所を押し下げてしまう。
 * 一方、同じ回数のものが並んだときは新しい方が今の生活に近いので、最終使用時刻を
 * タイブレークに使う。最後の文字列順は、回数も時刻も同じときに順序をぶれさせないため
 * (テストが安定する)。
 *
 * 表記揺れ (locationDedupeKey で同一視されたもの) は1件にまとめ、**画面に出す表記は
 * 多数決** ―― 一番よく使われている書き方が、その人にとっての「正しい書き方」に一番近い。
 */
export function collectLocationCandidates(
  sources: Iterable<LocationSource>,
  limit: number = MAX_LOCATION_CANDIDATES,
): string[] {
  const buckets = new Map<string, Bucket>();

  for (const source of sources) {
    if (!isSuggestableLocation(source.location)) continue;
    const display = normalizeLocation(source.location ?? "");
    const key = locationDedupeKey(display);
    const bucket = buckets.get(key) ?? { count: 0, lastMs: -Infinity, displays: new Map() };
    bucket.count++;
    bucket.lastMs = Math.max(bucket.lastMs, source.atMs);
    const variant = bucket.displays.get(display) ?? { count: 0, lastMs: -Infinity };
    variant.count++;
    variant.lastMs = Math.max(variant.lastMs, source.atMs);
    bucket.displays.set(display, variant);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      display: pickDisplay(bucket),
      count: bucket.count,
      lastMs: bucket.lastMs,
    }))
    .sort(
      (a, b) =>
        b.count - a.count || b.lastMs - a.lastMs || a.display.localeCompare(b.display, "ja"),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.display);
}

/** 表記揺れの多数決 (同数なら新しい方、それも同じなら文字列順で安定させる) */
function pickDisplay(bucket: Bucket): string {
  let best: { display: string; count: number; lastMs: number } | null = null;
  for (const [display, stat] of bucket.displays) {
    if (
      best === null ||
      stat.count > best.count ||
      (stat.count === best.count && stat.lastMs > best.lastMs) ||
      (stat.count === best.count &&
        stat.lastMs === best.lastMs &&
        display.localeCompare(best.display, "ja") < 0)
    ) {
      best = { display, count: stat.count, lastMs: stat.lastMs };
    }
  }
  // buckets には必ず1件以上の display があるので best が null になることはない
  return best?.display ?? "";
}

/**
 * 入力中の文字列で候補を絞る。
 *
 * **部分一致**にしてある。日本語の場所名は「西ヶ原四丁目治療院」「〇〇ビル 12F 会議室A」の
 * ように*後ろの方に効き目のある語が来る*ことが多く、前方一致だけだと「治療院」「会議室」と
 * 打っても何も出ない ―― 実際に思い出せるのが末尾の語だけ、という場面で役に立たない。
 * ただし前方一致で当たったものは意図に近いので**先に**並べる。
 *
 * 比較は locationDedupeKey と同じ正規化 (NFKC + 小文字 + 空白除去) を通してから行うので、
 * `かいぎしつ` を全角で打っても半角で打っても、`room a` と打っても `Room A` に当たる。
 *
 * candidates は collectLocationCandidates が返した順 (使用回数順) である前提で、
 * 同じ一致種別の中ではその順序をそのまま保つ (Array#sort は安定ソート)。
 */
export function filterLocationSuggestions(
  candidates: readonly string[],
  query: string,
  limit: number = MAX_LOCATION_SUGGESTIONS,
): string[] {
  const max = Math.max(0, limit);
  const key = locationDedupeKey(query);
  // 未入力なら「よく使う場所」の上位をそのまま出す (フォーカスしただけで候補が見える)
  if (key.length === 0) return candidates.slice(0, max);

  return candidates
    .map((display) => ({ display, rank: matchRank(locationDedupeKey(display), key) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, max)
    .map((entry) => entry.display);
}

/** 0=前方一致 / 1=部分一致 / -1=一致しない */
function matchRank(candidateKey: string, queryKey: string): number {
  if (candidateKey.startsWith(queryKey)) return 0;
  return candidateKey.includes(queryKey) ? 1 : -1;
}
