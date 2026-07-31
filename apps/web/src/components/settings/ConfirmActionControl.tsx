/**
 * 設定モーダルの各セクションが共有する「インライン2段階確認」だけを担当するファイル。
 *
 * 連携解除 (アカウント/GitHub)・MCP トークン失効・キャッシュ削除・再同期の5箇所が使う
 * 唯一の実装で、ここ以外に確認 UI を持たせないことが「どれかだけ確認を飛ばす/disabled が
 * 抜ける」といったズレの再発を防ぐ。セクション分割 (2026-07-31) にあたって、
 * どのセクションからも等距離になるようこの独立ファイルへ置いた。
 */
import { useState } from "react";

type ConfirmActionState = "idle" | "confirming" | "running" | "done" | "error";

/**
 * インライン2段階確認の共通コンポーネント (2026-07-29)。
 *
 * 連携解除 (アカウント/GitHub)・MCP トークン失効・キャッシュ削除は、state マシンも JSX 構造も
 * 完全に同一で、違うのは**ラベルと確定時の処理だけ**だった。5つ目 (再同期) を足すにあたって
 * ここに畳んだ ―― コピーが増えるほど「どれかだけ確認を飛ばす/disabled が抜ける」といった
 * ズレが入り込む余地が増えるため。DOM (span のクラス名と要素の並び) は畳む前と1文字も
 * 変えていないので、既存4つの見た目・挙動はそのまま。
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
      <span className="settings-modal-disconnect-confirm">
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
    <span className="settings-modal-disconnect-row">
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
