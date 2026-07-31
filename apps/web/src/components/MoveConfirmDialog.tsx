import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatDetailDateTime } from "../layout/gridMetrics";
import type { Occurrence } from "../model/types";
import { DEFAULT_GUEST_NOTIFY, type GuestNotify } from "../sync/guestNotify";
import { DEFAULT_RECURRENCE_SCOPE, type RecurrenceScope } from "../sync/recurrenceScope";
import "./MoveConfirmDialog.css";

export interface MoveConfirmDialogProps {
  title: string;
  timeZone: string;
  /**
   * 変更前後の時間帯。移動の確認 (purpose='move') でのみ渡す ―― 編集フォームの
   * 適用範囲の確認では、内容も一緒に変わっていて「時刻 → 時刻」の1行では表しきれない
   * ので出さない(フォーム側に入力内容がそのまま残っている)。
   */
  previous?: Occurrence;
  updated?: Occurrence;
  /**
   * 用途 (2026-07-30、2026-07-31 に 'delete' を追加)。'move' (既定) = ドラッグ移動の確認、
   * 'edit' = 編集内容の適用範囲確認、'delete' = ゲストのいる予定の削除確認。
   * 見出しと確定ボタンの文言、注記の言い回しだけが変わる。
   */
  purpose?: "move" | "edit" | "delete";
  /**
   * 繰り返し予定で選ばせる適用範囲 (2026-07-30、sync/recurrenceScope.ts)。
   * **空/未指定なら選択 UI を一切描かない** ―― 繰り返しでない予定は 2026-07-30 以前と
   * 完全に同じ見た目・同じキーボード操作のままになる。
   */
  scopes?: readonly RecurrenceScope[];
  /**
   * ゲストへの通知を選ばせるか (2026-07-31、sync/guestNotify.ts の shouldAskGuestNotify)。
   * **false/未指定なら選択 UI を一切描かない** ―― ゲストのいない予定・自分が主催でない
   * 予定では、2026-07-31 以前と完全に同じ見た目・同じキーボード操作のままになる
   * (scopes と全く同じ「出さないときは1pxも動かない」流儀)。
   */
  askNotify?: boolean;
  onConfirm: (scope: RecurrenceScope, notify: GuestNotify) => void;
  onCancel: () => void;
}

const SCOPE_LABEL: Record<RecurrenceScope, string> = {
  this: "この予定のみ",
  all: "すべての予定",
};

/**
 * 用途ごとに変わるのはこの3つの文言だけ (2026-07-31 に 'delete' を追加した際、
 * 三項演算子の入れ子になっていたものを表に開いた ―― 用途が3つになると
 * `purpose === "edit" ? A : B` の形では「残りはどっち」が読めなくなるため)。
 */
const PURPOSE_TEXT: Record<
  NonNullable<MoveConfirmDialogProps["purpose"]>,
  { ariaLabel: string; question: (title: string) => string; confirm: string }
> = {
  move: {
    ariaLabel: "予定の移動確認",
    question: (title) => `「${title}」を移動しますか?`,
    confirm: "移動する",
  },
  edit: {
    ariaLabel: "予定の変更の適用範囲",
    question: (title) => `「${title}」の変更を保存しますか?`,
    confirm: "保存する",
  },
  delete: {
    ariaLabel: "予定の削除確認",
    question: (title) => `「${title}」を削除しますか?`,
    confirm: "削除する",
  },
};

/**
 * ゲストへの通知の選択肢 (2026-07-31)。値は Google の sendUpdates そのもの
 * (shared の EventSendUpdates 参照)。**「送信しない」は none ではなく externalOnly** で、
 * Google カレンダー以外のゲストには送られる ―― 下の注記で必ずそう書く。
 */
const NOTIFY_OPTIONS: readonly { value: GuestNotify; label: string }[] = [
  { value: "all", label: "送信する" },
  { value: "externalOnly", label: "送信しない" },
];

/**
 * ドラッグ移動の確認ダイアログ(フェーズ2、2026-07-22)。WeekGrid 上でイベントを
 * ドラッグ移動 (kind==='move') すると楽観的に見た目だけ即座に動く(store.update 済み)が、
 * まだ IndexedDB/Google への書き込みは行っていない状態でこのダイアログを挟む。
 * 「移動する」で App.tsx の handlePersist(従来のドラッグ確定処理)を呼び、
 * 「キャンセル」で previous を store.update するだけで元の位置に戻せる
 * (sync/moveConfirm.ts のコメント参照)。
 *
 * 2026-07-30 の「繰り返し予定の適用範囲」で、**新しいダイアログを増やさずに**
 * 2つの役目を持たせた:
 *  1. 従来どおりのドラッグ移動の確認 (purpose='move')。
 *  2. 編集フォーム保存時の「どの予定に適用するか」の確認 (purpose='edit')。
 * 後者を別コンポーネントにしなかったのは、出す条件 (繰り返し予定を変更しようとしている)
 * も、聞くこと (適用範囲) も、押せる操作 (確定/キャンセル) も同じだからで、意匠を2つに
 * 分けると「移動のときだけ選択肢の並びが違う」といったズレを産む。
 *
 * 2026-07-31 の「ゲストへの通知」も同じ考えでここに足した (askNotify)。Google カレンダー
 * 自身が、ゲストのいる予定を動かすと更新メールを送るか訊いてくるのと同じ問いかけで、
 * 出す条件も押せる操作も適用範囲と同じ ―― **移動の確認は元々ドラッグのたびに出るので、
 * ここに相乗りすれば操作の回数は1回も増えない**。編集フォームの保存では、繰り返しでない
 * 予定でもゲストがいればこのダイアログが出るようになる (Google カレンダーと同じ挙動)。
 *
 * 同じ日に purpose='delete' も足した。削除は元々ポップオーバー内のインライン2段階確認
 * (「削除しますか? 削除する / やめる」) だけで、通知の選択を置く場所が無い ―― あの狭い
 * 1行に fieldset と注記を押し込むと、同じ問いかけが移動のときと違う形で現れることになる。
 * そこで**ゲストがいて自分が主催のときだけ**、インライン確認をこのダイアログに**格上げ**する
 * (EventDetailCard.tsx の EventDeleteControl)。ダイアログ自身が「削除しますか?」の確認を
 * 兼ねるので、押す回数は格上げ前と同じ2回のまま。格上げの根拠は**削除が取り消せない**こと
 * ―― 移動なら選び間違えても動かし直せるが、削除して初めて「ゲストに伝わっていない」と
 * 気付いても戻せない。狭い1行の中の小さなラジオではなく、画面中央で手を止めさせる。
 * (Google カレンダーの削除がどう訊いてくるかは公式に文書化されていない ―― 更新については
 * "you have the option to email them invitations" と書かれているが、削除の問いかけの文言も
 * 選択肢も公式ヘルプに記述が無いので、真似ではなく上の理屈で決めた。)
 *
 * BlockRulesOverlay.tsx と同じ画面中央のバックドロップ+カード構成。キーボード
 * Enter=確定/Esc=キャンセル(要件どおり)。適用範囲は <fieldset> + ラジオで、
 * 上下キーによる選択はブラウザ標準の挙動に任せる。
 */
export function MoveConfirmDialog({
  title,
  previous,
  updated,
  timeZone,
  purpose = "move",
  scopes,
  askNotify = false,
  onConfirm,
  onCancel,
}: MoveConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  // 既定は「この予定のみ」(Google カレンダーに合わせた、最も影響が小さい方)
  const [scope, setScope] = useState<RecurrenceScope>(DEFAULT_RECURRENCE_SCOPE);
  // 既定は「送信する」(sync/guestNotify.ts の DEFAULT_GUEST_NOTIFY に理由を書いた)。
  // askNotify が false のときもこの値をそのまま返すが、受け手 (resolveSendUpdates) が
  // subject を見て安全側に倒すので影響しない。
  const [notify, setNotify] = useState<GuestNotify>(DEFAULT_GUEST_NOTIFY);
  const text = PURPOSE_TEXT[purpose];
  // 選択肢が2つ以上あるときだけラジオを出す。1つきりのときは「なぜ1つなのか」を
  // 文章で伝える(押せない選択肢を並べて見せるのは、選べるように見えて紛らわしい)
  const hasChoice = (scopes?.length ?? 0) > 1;
  const isRecurring = (scopes?.length ?? 0) > 0;

  // 開いたら即座にカードへフォーカスし、Enter/Esc がすぐ効くようにする
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm(scope, notify);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div
      className="move-confirm-backdrop"
      onPointerDown={(e) => {
        // バックドロップ自身(カードの外側)をクリックしたときだけキャンセル扱いにする
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className="move-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label={text.ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <p className="move-confirm-title">{text.question(title)}</p>
        {previous && updated && (
          <p className="move-confirm-range">
            <span className="move-confirm-from">
              {formatDetailDateTime(previous.startMs, previous.endMs, timeZone)}
            </span>
            <span className="move-confirm-arrow" aria-hidden="true">
              →
            </span>
            <span className="move-confirm-to">
              {formatDetailDateTime(updated.startMs, updated.endMs, timeZone)}
            </span>
          </p>
        )}

        {hasChoice && (
          <fieldset className="move-confirm-scope">
            <legend className="move-confirm-scope-legend">適用範囲</legend>
            {scopes?.map((value) => (
              <label key={value} className="move-confirm-scope-option">
                <input
                  type="radio"
                  name="move-confirm-scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                {SCOPE_LABEL[value]}
              </label>
            ))}
          </fieldset>
        )}
        {isRecurring && !hasChoice && (
          <p className="move-confirm-note">
            繰り返し予定のこの回だけに適用される。
            {purpose === "move"
              ? "日をまたぐ移動は繰り返しの曜日そのものが変わるため、シリーズ全体には適用できない。"
              : "開始日を別の日にする変更は繰り返しの曜日そのものが変わるため、シリーズ全体には適用できない。"}
            繰り返しの間隔や曜日を変えるときは Google カレンダー側で行う。
          </p>
        )}

        {/*
         * ゲストへの通知 (2026-07-31)。適用範囲と全く同じ見た目 (fieldset + ラジオ) を
         * 使い回す ―― 同じダイアログの中で問いかけの形が2種類あると、どちらが何の
         * 選択なのか読み取りにくくなる。新しいクラスも新しい意匠も足していない。
         */}
        {askNotify && (
          <>
            <fieldset className="move-confirm-scope">
              <legend className="move-confirm-scope-legend">ゲストへの通知</legend>
              {NOTIFY_OPTIONS.map((option) => (
                <label key={option.value} className="move-confirm-scope-option">
                  <input
                    type="radio"
                    name="move-confirm-notify"
                    value={option.value}
                    checked={notify === option.value}
                    onChange={() => setNotify(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            <p className="move-confirm-note">
              「送信しない」でも、Google カレンダー以外のゲストにはメールが届く ――
              相手のカレンダーを
              {purpose === "delete" ? "取り消す" : "直す"}手段が他に無いためだ。Google
              カレンダーのゲストの予定は、メールが無くても
              {purpose === "delete" ? "同期で消える" : "同期で直る"}。
            </p>
          </>
        )}

        <div className="move-confirm-actions">
          <button
            type="button"
            className="move-confirm-confirm-btn"
            onClick={() => onConfirm(scope, notify)}
          >
            {text.confirm}
          </button>
          <button type="button" className="move-confirm-cancel-btn" onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
