/**
 * 「楽観更新した1件を Google へ書き戻す POST」の定型だけを切り出した層
 * (useEventMutations の分割、2026-07-31)。
 *
 * なぜ切り出したか: 変更系フックの4経路 —— ドラッグ確定 (POST /api/event/patch)・
 * 新規作成 (/api/event/create)・削除 (/api/event/delete)・タスクの完了トグル
 * (/api/task/patch) —— が、まったく同じ12行を各々インラインで書いていた:
 *
 *   try { const res = await checkedFetch(path, jsonInit("POST", body));
 *         if (!res.ok) console.error(`kichijitsu: POST ${path} failed (${id}): ${res.status}`);
 *         return res.ok; }
 *   catch (err) { console.error(`kichijitsu: POST ${path} failed`, err); return false; }
 *
 * この4つは**揃って「失敗したらロールバックする」**判断に使われるので、成否の決め方
 * (非 2xx もネットワーク例外も等しく false) がズレると片方だけ巻き戻らない事故になる。
 * 判定とログ書式を1箇所にして、テストで固めておく価値が高い。
 *
 * httpJson.ts の throw する高レベル関数 (postJson 等) を使わないのは、ここが
 * **throw しない**層だから ―― 呼び出し側は「false ならロールバック」という素直な形で
 * 書けるべきで、例外を投げ直して catch させるのは経路が増えるだけになる。
 * ログ文言 (kichijitsu: 接頭辞) も既存の出力をそのまま保っている。
 */
import { jsonInit, type CheckedFetch } from "./httpJson";

/** 書き戻しの結果。ok===false のときは既にログ済み(呼び出し側はロールバックするだけでよい) */
export interface WriteBackResult<T> {
  ok: boolean;
  /** readOk を渡したときだけ入る(成功時のみ) */
  value?: T;
}

/**
 * JSON ボディを POST し、成否を返す。非 2xx もネットワーク例外も等しく ok:false。
 *
 * @param subjectId ログに出す対象の id(どの予定/タスクの書き戻しが落ちたか分かるように)
 * @param readOk 成功時に応答ボディを読む関数。**try の内側で呼ぶ**ので、JSON パースの
 *   失敗もネットワーク例外と同じ扱い (ok:false → 呼び出し側でロールバック) になる
 *   —— 新規作成が eventId を読めなかったときに仮 occurrence を残さないため。
 */
export async function postWriteBack<T = void>(
  fetcher: CheckedFetch,
  path: string,
  body: unknown,
  subjectId: string,
  readOk?: (res: Response) => Promise<T>,
): Promise<WriteBackResult<T>> {
  try {
    const res = await fetcher(path, jsonInit("POST", body));
    if (!res.ok) {
      console.error(`kichijitsu: POST ${path} failed (${subjectId}): ${res.status}`);
      return { ok: false };
    }
    return { ok: true, value: readOk ? await readOk(res) : undefined };
  } catch (err) {
    console.error(`kichijitsu: POST ${path} failed`, err);
    return { ok: false };
  }
}

/**
 * リクエストを組み立てられなかった(build*Request が undefined を返した)ときのログ。
 * 呼び出し側で「書き戻しをやめる」判断とセットで使う ―― 文言を揃えるためだけの小さな関数。
 *
 * @param skipping やめた操作の名前。削除経路だけは "delete" と出していた既存の文言を保つ
 */
export function logSkippedWriteBack(what: string, subjectId: string, skipping = "write-back"): void {
  console.error(`kichijitsu: could not build ${what}, skipping ${skipping}`, subjectId);
}
