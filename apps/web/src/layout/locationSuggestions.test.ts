import { describe, expect, it } from "vite-plus/test";
import {
  collectLocationCandidates,
  filterLocationSuggestions,
  isSuggestableLocation,
  locationDedupeKey,
  MAX_LOCATION_CANDIDATES,
  MAX_LOCATION_SUGGESTIONS,
  normalizeLocation,
  type LocationSource,
} from "./locationSuggestions";

/** テストデータを短く書くためのヘルパー (atMs は「日」単位の適当な連番でよい) */
function src(location: string | undefined, atMs = 0): LocationSource {
  return { location, atMs };
}

describe("normalizeLocation", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeLocation("  会議室A  ")).toBe("会議室A");
  });

  it("全角スペースも空白として扱う", () => {
    expect(normalizeLocation("　会議室A　")).toBe("会議室A");
  });

  it("連続する空白は半角1つに畳む", () => {
    expect(normalizeLocation("本社  12F   会議室A")).toBe("本社 12F 会議室A");
  });

  it("大文字小文字や全角/半角の表記自体は変えない(表示に使うため)", () => {
    expect(normalizeLocation("Ｒｏｏｍ A")).toBe("Ｒｏｏｍ A");
  });
});

describe("locationDedupeKey", () => {
  it("全角/半角の揺れを同一視する", () => {
    expect(locationDedupeKey("会議室Ａ")).toBe(locationDedupeKey("会議室A"));
  });

  it("半角カナと全角カナを同一視する", () => {
    expect(locationDedupeKey("ｶﾌｪ")).toBe(locationDedupeKey("カフェ"));
  });

  it("大文字小文字を同一視する", () => {
    expect(locationDedupeKey("Room A")).toBe(locationDedupeKey("room a"));
  });

  it("空白の有無を同一視する", () => {
    expect(locationDedupeKey("会議室 A")).toBe(locationDedupeKey("会議室A"));
  });

  it("別の場所は別のキーになる", () => {
    expect(locationDedupeKey("会議室A")).not.toBe(locationDedupeKey("会議室B"));
  });
});

describe("isSuggestableLocation", () => {
  it("undefined と空文字は候補にしない", () => {
    expect(isSuggestableLocation(undefined)).toBe(false);
    expect(isSuggestableLocation("")).toBe(false);
  });

  it("空白だけの文字列は候補にしない", () => {
    expect(isSuggestableLocation("   　  ")).toBe(false);
  });

  it("Slack ハドルの URL(実データ)は候補にしない", () => {
    expect(isSuggestableLocation("https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW")).toBe(false);
  });

  it("Zoom / Meet の URL も候補にしない", () => {
    expect(isSuggestableLocation("https://zoom.us/j/1234567890")).toBe(false);
    expect(isSuggestableLocation("https://meet.google.com/abc-defg-hij")).toBe(false);
  });

  it("説明付きで URL を含む形も候補にしない", () => {
    expect(isSuggestableLocation("オンライン https://zoom.us/j/1234567890")).toBe(false);
  });

  it("極端に長い文字列は候補にしない", () => {
    expect(isSuggestableLocation("あ".repeat(121))).toBe(false);
    expect(isSuggestableLocation("あ".repeat(120))).toBe(true);
  });

  it("住所・会議室名は候補にする", () => {
    expect(isSuggestableLocation("西ヶ原四丁目治療院")).toBe(true);
    expect(isSuggestableLocation("会議室A")).toBe(true);
  });
});

describe("collectLocationCandidates", () => {
  it("使用回数の多い順に並べる", () => {
    const candidates = collectLocationCandidates([
      src("会議室A"),
      src("カフェ"),
      src("会議室A"),
      src("会議室B"),
      src("会議室A"),
      src("カフェ"),
    ]);
    expect(candidates).toEqual(["会議室A", "カフェ", "会議室B"]);
  });

  it("回数が同じなら最近使った順で並べる", () => {
    const candidates = collectLocationCandidates([
      src("古い場所", 1_000),
      src("新しい場所", 9_000),
    ]);
    expect(candidates).toEqual(["新しい場所", "古い場所"]);
  });

  it("回数も時刻も同じなら文字列順で安定する", () => {
    const candidates = collectLocationCandidates([src("BBB", 5), src("AAA", 5)]);
    expect(candidates).toEqual(["AAA", "BBB"]);
  });

  it("表記揺れは1件にまとめ、表示は多数決で選ぶ", () => {
    const candidates = collectLocationCandidates([
      src("会議室A"),
      src("会議室Ａ"),
      src("会議室 A"),
      src("会議室A"),
    ]);
    expect(candidates).toEqual(["会議室A"]);
  });

  it("まとめた件数は合算して並び順に効く", () => {
    // 「会議室A」系は表記揺れ込みで合計3回、「カフェ」は2回 → まとまった側が上に来る。
    // 表示は多数決なので、2回使われている "会議室A" の表記が選ばれる
    const candidates = collectLocationCandidates([
      src("カフェ"),
      src("カフェ"),
      src("会議室A"),
      src("会議室A"),
      src("会議室Ａ"),
    ]);
    expect(candidates).toEqual(["会議室A", "カフェ"]);
  });

  it("空文字・空白・URL は候補に混ざらない", () => {
    const candidates = collectLocationCandidates([
      src(undefined),
      src(""),
      src("   "),
      src("https://app.slack.com/huddle/T25JPTN0M/CGDR6P8KW"),
      src("https://meet.google.com/abc-defg-hij"),
      src("会議室A"),
    ]);
    expect(candidates).toEqual(["会議室A"]);
  });

  it("候補は上限で打ち切る(既定は MAX_LOCATION_CANDIDATES)", () => {
    const many = Array.from({ length: MAX_LOCATION_CANDIDATES + 50 }, (_, i) =>
      src(`場所${i}`, i),
    );
    expect(collectLocationCandidates(many)).toHaveLength(MAX_LOCATION_CANDIDATES);
    expect(collectLocationCandidates(many, 3)).toHaveLength(3);
  });

  it("上限で落ちるのは回数の少ない(=順位の低い)ものから", () => {
    const candidates = collectLocationCandidates(
      [src("常連", 1), src("常連", 2), src("一度きり", 3)],
      1,
    );
    expect(candidates).toEqual(["常連"]);
  });

  it("1件も無ければ空配列", () => {
    expect(collectLocationCandidates([])).toEqual([]);
  });
});

describe("filterLocationSuggestions", () => {
  const candidates = ["会議室A", "本社 12F 会議室B", "西ヶ原四丁目治療院", "Room A", "カフェ"];

  it("未入力なら候補の上位をそのまま返す", () => {
    expect(filterLocationSuggestions(candidates, "")).toEqual(candidates);
  });

  it("空白だけの入力も未入力として扱う", () => {
    expect(filterLocationSuggestions(candidates, "  　 ")).toEqual(candidates);
  });

  it("部分一致で絞る(日本語は後ろの語しか思い出せないことが多いため)", () => {
    expect(filterLocationSuggestions(candidates, "治療院")).toEqual(["西ヶ原四丁目治療院"]);
  });

  it("前方一致のものを部分一致より先に出す", () => {
    // 「会議室」は "会議室A" の先頭、"本社 12F 会議室B" の途中に現れる
    expect(filterLocationSuggestions(candidates, "会議室")).toEqual([
      "会議室A",
      "本社 12F 会議室B",
    ]);
  });

  it("全角/半角・大文字小文字・空白の揺れを無視して当たる", () => {
    expect(filterLocationSuggestions(candidates, "会議室Ａ")).toEqual(["会議室A"]);
    expect(filterLocationSuggestions(candidates, "room a")).toEqual(["Room A"]);
    expect(filterLocationSuggestions(candidates, "本社12f")).toEqual(["本社 12F 会議室B"]);
  });

  it("一致しなければ空配列(空の入れ物を出さないための判定に使う)", () => {
    expect(filterLocationSuggestions(candidates, "存在しない場所")).toEqual([]);
  });

  it("同じ一致種別の中では元の並び(使用回数順)を保つ", () => {
    expect(filterLocationSuggestions(["よく使うA室", "たまに使うA室"], "A室")).toEqual([
      "よく使うA室",
      "たまに使うA室",
    ]);
  });

  it("表示件数は上限で打ち切る(既定は MAX_LOCATION_SUGGESTIONS)", () => {
    const many = Array.from({ length: 100 }, (_, i) => `会議室${i}`);
    expect(filterLocationSuggestions(many, "会議室")).toHaveLength(MAX_LOCATION_SUGGESTIONS);
    expect(filterLocationSuggestions(many, "会議室", 5)).toHaveLength(5);
    expect(filterLocationSuggestions(many, "")).toHaveLength(MAX_LOCATION_SUGGESTIONS);
  });
});
