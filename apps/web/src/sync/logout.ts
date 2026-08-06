/**
 * ログアウトの本体 (2026-08-06、ユーザー要望「ログアウトの導線」)。
 *
 * 仕様: ログアウトは**セッションと端末内のデータの両方**を消す。kichijitsu はローカルファースト
 * (予定データが IndexedDB にある) ため、サーバーのセッション Cookie を消すだけでは端末に
 * 予定の写しが丸ごと残ってしまう ―― それを避けるのがこの関数の役目。
 *
 * ## 順序: 端末内データを先に消し、そのあとサーバーへログアウトを要求する
 * 逆順 (先に POST /auth/logout) だと、「セッションは切れたのに端末データの削除だけ失敗した」
 * という一番まずい状態になりうる ―― 利用者からは「ログアウトした」ように見える(実際
 * ボタンを押してエラーが出なければセッションは切れている)のに、端末には予定データが
 * 残ったままになる。この順序なら、データ削除に失敗した時点でまだセッションが生きているので
 * 「ログアウトは成立していない」と一貫して伝えられるし、もう一度試すことも安全にできる。
 *
 * fetch/DB/Storage の実体は呼び出し元 (settings/LogoutControl.tsx → App.tsx) が注ぎ込む
 * ―― この関数自体は window/document に触れないので、フェイクを渡すだけでテストできる。
 */
import { postJsonVoid, type CheckedFetch } from "./httpJson";
import { clearKichijitsuLocalStorage, type EnumerableStorage } from "./logoutLocalStorage";

/**
 * ログアウトのどちらの段階で失敗したかを表す。
 * - "local-data": 端末内データ (localStorage / IndexedDB) の削除に失敗した。
 *   **セッションはまだ生きている** ―― サーバーへのログアウト要求はまだ送っていない。
 * - "session": 端末内データの削除は終わったが、サーバーへのログアウト要求
 *   (POST /auth/logout) が失敗した。**端末データは既に無い**。
 *
 * どちらで失敗したかによって利用者が取るべき行動(据え置いてよいか、もう一度押すべきか)が
 * 違うため、呼び出し元 (LogoutControl) が失敗表示を出し分けられるよう区別して持ち運ぶ。
 * 「失敗したら黙って成功扱いにしない」の要件を満たすのがこのクラスの役目。
 */
export class LogoutError extends Error {
  readonly stage: "local-data" | "session";

  constructor(stage: "local-data" | "session", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogoutError";
    this.stage = stage;
  }
}

export interface PerformLogoutDeps {
  /** window.localStorage 相当。テストではフェイクを渡す */
  storage: EnumerableStorage;
  /**
   * IndexedDB のうち Google/GitHub 由来の写し・同期メタデータだけを消す関数。
   * db/database.ts の LOGOUT_CLEARED_STORES を clear する想定 (2026-08-06、仕様変更 ――
   * 当初は DB ごと削除していたが、plannedBlocks/timeEntries はサーバーに対応が無く
   * 消すと復元できないため、ストア単位の削除に変えた)。
   * **plannedBlocks/timeEntries には触れない**(呼び出し元 = db/database.ts の責務)。
   */
  clearLocalDb: () => Promise<void>;
  /** App.tsx の checkedFetch (オフライン判定を挟む fetch ラッパー) */
  checkedFetch: CheckedFetch;
}

/**
 * ログアウト本体。**端末内データを先に消し切ってから** POST /auth/logout を叩く
 * (順序の理由はファイル冒頭のコメント参照)。
 *
 * 端末内データの削除は localStorage (同期・例外を投げうる) と IndexedDB の対象ストア
 * (clearLocalDb、非同期) の2箇所ぶんをまとめて1段階として扱う ―― どちらが失敗しても
 * LogoutError の stage は一律 "local-data" になる(利用者から見れば「端末データの削除に
 * 失敗した」という1つの事実であり、内訳は console.error に残る cause で十分)。
 */
export async function performLogout(deps: PerformLogoutDeps): Promise<void> {
  try {
    clearKichijitsuLocalStorage(deps.storage);
    await deps.clearLocalDb();
  } catch (err) {
    throw new LogoutError("local-data", "端末データの削除に失敗しました", { cause: err });
  }

  try {
    await postJsonVoid(deps.checkedFetch, "/auth/logout");
  } catch (err) {
    throw new LogoutError("session", "ログアウト要求に失敗しました", { cause: err });
  }
}
