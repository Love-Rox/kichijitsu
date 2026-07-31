/**
 * 設定モーダルの各セクションが共有する「インライン2段階確認」だけを担当するファイル。
 *
 * 連携解除 (アカウント/GitHub)・MCP トークン失効・キャッシュ削除・再同期の5箇所が使う
 * 唯一の実装で、ここ以外に確認 UI を持たせないことが「どれかだけ確認を飛ばす/disabled が
 * 抜ける」といったズレの再発を防ぐ。セクション分割 (2026-07-31) にあたって、
 * どのセクションからも等距離になるようこの独立ファイルへ置いた。
 *
 * ## 適用範囲は設定モーダルの中だけ (2026-07-31 の判断)
 * アプリには他にも「押す → 訊く → 実行する」の導線が4つある
 * (EventDetailCard の削除とゲスト削除、BlockRulesOverlay のルール削除、WorkLogHistory の
 * 実績削除)。**これらをここへ畳むのは意図的に見送った** ―― 似ているのは
 * 「span の中に問いかけと2つのボタンが並ぶ」という15行ぶんの JSX だけで、
 * このコンポーネントの値打ちである**状態機械が全部違う**ため:
 *   - EventDetailCard の削除は非同期を待たない (楽観削除なので押した瞬間に閉じる)。
 *     実行中も失敗表示も存在しない。
 *   - ゲスト削除の disabled はゲスト欄ぜんたいで共有する `pending` (追加の送信中も
 *     外すボタンが止まる)。問いかけの文が無く、失敗表示は欄の一番下に、しかも
 *     入力エラーと同じ場所へ理由別の文で出る。
 *   - BlockRulesOverlay は確認の中に**チェックボックスと、その状態で変わる注記**を持ち、
 *     実行ボタンのラベルも「削除中…」に変わる。
 *   - WorkLogHistory は成功でも失敗でも idle に戻し (再取得が失敗しても固まらないため)、
 *     失敗表示は確認とは別の「操作」欄へ出る。
 * 畳むには className・問いかけの有無・追加の中身・実行中ラベル・disabled・失敗表示の
 * 置き場所を全部 props で外から注ぐことになり、**状態機械を1つも共有しない
 * 「DOM を組み立てるだけの部品」**が残る。それは「どれかだけ確認を飛ばす」を防ぐ力を
 * 持たないので、重複を消した見返りが無い。4つはそれぞれの場所に置いたままにする。
 */
import { useState } from "react";

type ConfirmActionState = "idle" | "confirming" | "running" | "done" | "error";

/**
 * インライン2段階確認の共通コンポーネント (2026-07-29)。
 *
 * 連携解除 (アカウント/GitHub)・MCP トークン失効・キャッシュ削除は、state マシンも JSX 構造も
 * 完全に同一で、違うのは**ラベルと確定時の処理だけ**だった。5つ目 (再同期) を足すにあたって
 * ここに畳んだ ―― コピーが増えるほど「どれかだけ確認を飛ばす/disabled が抜ける」といった
 * ズレが入り込む余地が増えるため。DOM (要素の並び) は畳む前と1文字も変えていないので、
 * 既存4つの見た目・挙動はそのまま (クラス名だけ 2026-07-31 に
 * .settings-modal-disconnect-* → .settings-modal-confirm-* へ改名した。5用途のうち
 * 「連携解除」1つの名前が全体に付いていたため。CSS 規則の中身は変えていない)。
 *
 * 成功後の振る舞いは呼び出し元によって違うので successLabel で切り替える:
 * - 未指定 (連携解除・失効・キャッシュ削除): 成功しても "running" のまま。呼び出し元 (App.tsx)
 *   が行ごと消す、あるいは window.location.reload() が走るため、idle に戻す意味が無い。
 * - 指定あり (再同期): この行は成功後も画面に残るので、完了を伝える表示に落ち着かせる。
 */
export function ConfirmActionControl({
  triggerLabel,
  question,
  confirmLabel,
  errorLabel,
  successLabel,
  logLabel,
  onConfirm,
}: {
  /** 平常時に出す文字ボタンのラベル (例: 「連携解除」) */
  triggerLabel: string;
  /** 確認段階の問いかけ (例: 「連携解除しますか？」) */
  question: string;
  /** 確認段階の実行ボタンのラベル (例: 「解除する」) */
  confirmLabel: string;
  /** 失敗時に出す短いラベル (例: 「解除失敗」) */
  errorLabel: string;
  /** 指定すると成功時にこのラベルを出して確認 UI を閉じる (省略時は成功後も実行中のまま) */
  successLabel?: string;
  /** console.error に出す識別子 (例: "account disconnect") */
  logLabel: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [state, setState] = useState<ConfirmActionState>("idle");

  if (state === "confirming" || state === "running") {
    return (
      <span className="settings-modal-confirm">
        {question}
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "running"}
          onClick={() => {
            setState("running");
            onConfirm()
              .then(() => {
                if (successLabel !== undefined) setState("done");
              })
              .catch((err: unknown) => {
                console.error(`kichijitsu: ${logLabel} failed`, err);
                setState("error");
              });
          }}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={state === "running"}
          onClick={() => setState("idle")}
        >
          やめる
        </button>
      </span>
    );
  }

  return (
    <span className="settings-modal-confirm-row">
      <button
        type="button"
        className="settings-modal-text-btn"
        onClick={() => setState("confirming")}
      >
        {triggerLabel}
      </button>
      {state === "error" && <span className="settings-modal-error">{errorLabel}</span>}
      {state === "done" && <span className="settings-modal-done">{successLabel}</span>}
    </span>
  );
}
