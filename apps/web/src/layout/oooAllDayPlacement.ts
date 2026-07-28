/**
 * 終日の不在 (OOO) をどこに描くかの表示設定 (2026-07-28、ユーザー要望
 * 「終日の不在は終日表示にするかタイムラインに載せるか選べるようにしたい」)。
 *
 * 2026-07-22 の不在レール導入以降、終日の不在は無条件に終日レーン (AllDayBar) から抜かれ、
 * 該当日の DayColumn に「その日の全高ライン」として描かれていた ―― その振り分けが
 * この2択になる (layout/oooRail.ts の splitOutOfOfficeAllDayGroups)。
 *
 * なぜ layout/ に置くか: この値を消費するのが同じ layout/ の純関数 (oooRail.ts) だから。
 * このリポジトリの依存の向きは sync → layout の一方向で、layout から sync を import して
 * いるモジュールは1つも無い(themePref.ts / githubProvider.ts のように sync 側が
 * layout/localStore.ts を使う向きだけがある)。設定モジュールを sync/ に置くと
 * oooRail.ts → sync/ という逆向きの矢印が生まれるため、layout/ 側に置いた。
 *
 * キー名と正規化の流儀は sync/themePref.ts に揃えてある ―― `kichijitsu:` 名前空間、
 * 壊れた値は既定へ倒す、try/catch は layout/localStore.ts に任せる。テーマと同じく
 * 「この端末の見え方」の設定なので、サーバー保存の「表示するカレンダー」ではなく
 * localStorage 側に置く(IndexedDB meta の declinedVisibility とも別扱い ―― あちらは
 * 予定の取捨選択そのもの、こちらは同じ予定をどこに描くかの純粋な見た目)。
 */
import { readStored, removeStored, writeStored, type StorageLike } from "./localStore";

/**
 * 終日の不在の置き場所の2択。
 * - "timeline" … 該当日の DayColumn に全高ラインとして載せる(既定 = 2026-07-22 以来の挙動)
 * - "allday"   … 終日レーン (AllDayBar) のチップとして、他の終日予定と並べて出す
 */
export type OooAllDayPlacement = "timeline" | "allday";

/**
 * 未設定 (初回) の既定値。現状維持のため "timeline" ―― 既存利用者の見え方を勝手に
 * 変えないため(declinedVisibility の showDeclined: true と同じ判断)。
 */
export const DEFAULT_OOO_ALLDAY_PLACEMENT: OooAllDayPlacement = "timeline";

/** localStorage キー。他の設定 (kichijitsu:theme, kichijitsu:hourHeight 等) と同じ名前空間 */
const OOO_ALLDAY_PLACEMENT_STORAGE_KEY = "kichijitsu:oooAllDayPlacement";

/**
 * 保存値を OooAllDayPlacement に正規化する。想定外の値はすべて既定の "timeline" に倒す。
 *
 * normalizeThemePref と同じ寛容さ: localStorage はユーザーが直接書き換えられるうえ、
 * 将来選択肢を増減させると古いバージョンが書いた値が残る。「読めない値なら現状維持
 * (タイムライン)に戻る」の一点だけ守れば、どんなゴミが入っていても不在の描画が壊れない。
 * ゆらぎ(大文字・前後空白)は受け付けない ―― 書くのはこのモジュール自身だけのため。
 */
export function normalizeOooAllDayPlacement(raw: string | null | undefined): OooAllDayPlacement {
  return raw === "allday" || raw === "timeline" ? raw : DEFAULT_OOO_ALLDAY_PLACEMENT;
}

/** 保存された設定を読む(未設定・壊れた値・localStorage が使えない環境は既定の "timeline") */
export function getOooAllDayPlacement(storage?: StorageLike): OooAllDayPlacement {
  return readStored(
    OOO_ALLDAY_PLACEMENT_STORAGE_KEY,
    normalizeOooAllDayPlacement,
    DEFAULT_OOO_ALLDAY_PLACEMENT,
    storage,
  );
}

/**
 * 設定を保存する(左ペイン「表示」のチェックから即座に呼ばれる)。
 * 既定値 "timeline" は保存値ごと消す ―― 「未設定 = 現状維持」と同じ状態に戻すのが素直で、
 * 既定を明示的に書き残す理由が無い(setThemePref の "auto" と同じ流儀)。
 */
export function setOooAllDayPlacement(pref: OooAllDayPlacement, storage?: StorageLike): void {
  if (pref === DEFAULT_OOO_ALLDAY_PLACEMENT) {
    removeStored(OOO_ALLDAY_PLACEMENT_STORAGE_KEY, storage);
  } else {
    writeStored(OOO_ALLDAY_PLACEMENT_STORAGE_KEY, pref, storage);
  }
}
