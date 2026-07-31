import { GoogleApiError } from "./errors";
import { patchEventRaw, type PatchEventRawParams } from "../google/patch-event-raw";
import { DEFAULT_SEND_UPDATES } from "./patch-event";

/**
 * 呼び出し元 (UserSyncDO.patchEventRaw) が渡すパラメータ。sendUpdates だけは渡させない ――
 * この関数はミラー専用で、値はここで決まるため (下のコメント参照)。
 */
export type MirrorPatchParams = Omit<PatchEventRawParams, "sendUpdates">;

/**
 * UserSyncDO.patchEventRaw が実装すべき依存先。core/patch-event.ts の PatchEventCoreDeps と
 * 同じ考え方で、DO storage / 実際の fetch を注入してロジックだけを単体テストできるようにする。
 */
export interface PatchEventRawCoreDeps {
  fetch: typeof fetch;
  /** キャッシュがあれば使い、無ければ (または期限切れなら) refresh_token から取り直す。 */
  getAccessToken: () => Promise<string>;
  /** キャッシュを無視して強制的にリフレッシュする (401 リトライ用)。 */
  forceRefreshAccessToken: () => Promise<string>;
}

/**
 * カレンダーブロック機能 (docs/blocking.md 第3段階) の mirror イベントの start/end を
 * source の値のまま (終日予定含む) 書き換える。core/patch-event.ts の
 * patchEventTimeWithRetry (epoch ms + timeZone、時刻予定限定) とは別物として用意した —
 * mirror は source の start/end (dateTime か date のいずれか) をそのまま写す必要があり、
 * all-day の mirror も正しく patch できることを優先するため。401 のみ 1 回だけ強制
 * リフレッシュして同じリクエストを再試行する。それ以外のエラーは握りつぶさず
 * GoogleApiError として伝播させる。
 *
 * 書き込みが成功しても戻り値は無い (void)。正本は次の同期で還流する設計であり、ここで
 * Google の応答をクライアントへそのまま返すことはしない (他の patch 系と同じ方針)。
 *
 * ## sendUpdates に既定値を入れる理由 (2026-07-31)
 * ミラー予定は kichijitsu が自分で作った「予定あり」の箱で、**参加者を持たない** ――
 * buildMirrorEventBody (core/block-reconcile.ts) は時間帯だけを写し、attendees を含む内容は
 * 一切写さない (無内容原則、docs/blocking.md)。したがって現状はどの値を送っても Google 側の
 * 結果は同じで、この変更で利用者に見える挙動は変わらない。
 *
 * それでも値を固定するのは、**「この層では必ず値が入る」という不変条件を破らないため**。
 * 選ぶのは kichijitsu 全体で一本の既定 (DEFAULT_SEND_UPDATES = externalOnly、
 * core/patch-event.ts のコメント参照) ―― ミラーは「利用者が明示的に全員へ知らせると
 * 言った」経路ではないので `all` にはしない。万一この経路に参加者のいる予定が来ても、
 * 頼まれてもいないメールを撒かない側に倒れる。
 */
export async function patchEventRawWithRetry(
  deps: PatchEventRawCoreDeps,
  params: MirrorPatchParams,
): Promise<void> {
  let accessToken = await deps.getAccessToken();
  let retriedAuth = false;

  for (;;) {
    const response = await patchEventRaw(deps.fetch, accessToken, {
      ...params,
      sendUpdates: DEFAULT_SEND_UPDATES,
    });

    if (response.status === 401 && !retriedAuth) {
      retriedAuth = true;
      accessToken = await deps.forceRefreshAccessToken();
      continue;
    }

    if (!response.ok) {
      throw new GoogleApiError(response.status, await response.text());
    }

    return;
  }
}
