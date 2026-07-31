/**
 * 設定モーダル下部の脱出口その1「キャッシュを削除して再読み込み」を担当するファイル。
 * 姉妹の脱出口である再同期 (ResyncControl.tsx) と対になっている。
 */
import { clearAppCaches } from "../../sync/appCache";
import { ConfirmActionControl } from "./ConfirmActionControl";

/**
 * 「キャッシュを削除して再読み込み」導線 (ユーザー要望、2026-07-26)。
 *
 * PWA / ブラウザでは Service Worker (public/sw.js) が静的アセットを cache-first で
 * 保持するため、再デプロイ後に古い画面が残ることがある。デスクトップ版のトレイ
 * 「再読み込み」(apps/desktop/src-tauri/src/lib.rs の RELOAD_JS) と同じ操作を
 * ユーザー自身が実行できるようにするのがこのボタン。
 *
 * 破壊的操作なので、他の脱出口と同じインライン2段階確認 (ConfirmActionControl、
 * window.confirm は使わない) に揃える。何が消えて何が消えないかは誤解されやすいため、
 * 確認前から説明文を常時出しておく。
 */
export function CacheClearControl() {
  return (
    <div className="settings-modal-cache">
      {/* JSX に日本語を直接改行して書くと折り返し位置に半角スペースが入るため、
          説明文は文字列連結で組んでから埋め込む。 */}
      <p className="settings-modal-section-desc">
        {"表示が古いままのときに使います。消えるのは画面を組み立てるファイルのキャッシュだけで、" +
          "カレンダーの予定データ・連携アカウント・設定は消えません。"}
      </p>
      <ConfirmActionControl
        triggerLabel="キャッシュを削除して再読み込み"
        question="削除して再読み込みしますか？"
        confirmLabel="削除する"
        errorLabel="削除失敗"
        logLabel="clearing app caches"
        // successLabel なし: 成功したら window.location.reload() で画面ごと作り直されるため
        onConfirm={() =>
          clearAppCaches().then((keys) => {
            // 削除したキー名はサポート時の手がかりとして残す(表示はしない)
            console.info("kichijitsu: cleared app caches", keys);
            // リロードで Service Worker が最新アセットを取り直し、キャッシュを埋め直す
            window.location.reload();
          })
        }
      />
    </div>
  );
}
