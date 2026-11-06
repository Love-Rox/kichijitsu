import { startGoogleAuth } from "../sync/desktopAuth";
import "./OnboardingCard.css";

/**
 * Google 未連携の初回に、空のグリッドの上へ重ねる案内カード(UI 刷新 段階4)。
 *
 * 以前は未連携だとグリッドが空のまま表示され、次に何をすればよいかの手掛かりが
 * ツールバー右上の小さな「Google 連携」ボタンだけだった。ここでは「何ができるか」と
 * 「次の1手」を1枚で示す。
 *
 * 表示条件は呼び出し側(App.tsx)が `meStatus === "signed-out"` で絞る ―― 確認中や
 * サーバー不達で出すと誤案内になるため。プライバシー/規約リンクは、未ログインの訪問者へ
 * 規約への導線を確保する要件(AppToolbar.tsx のフォールバックと同じ)を満たすために置く。
 */
export function OnboardingCard() {
  return (
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <h2 id="onboarding-title" className="onboarding-title">
        Google カレンダーをつないで始めましょう
      </h2>
      <ol className="onboarding-steps">
        <li>
          <strong>Google でログイン</strong>
          <span>カレンダーの予定とタスクを読み込みます。</span>
        </li>
        <li>
          <strong>表示するカレンダーを選ぶ</strong>
          <span>左のパネルで、見たいカレンダーだけを残せます。</span>
        </li>
        <li>
          <strong>週・月で予定を確認する</strong>
          <span>ドラッグで予定を移動、空き時間をドラッグで新規作成できます。</span>
        </li>
      </ol>
      <button
        type="button"
        className="onboarding-cta"
        onClick={() => {
          // ツールバーの「Google 連携」と同じ入口。デスクトップ版は外部ブラウザで開く
          void startGoogleAuth({ kind: "login" });
        }}
      >
        Google でログイン
      </button>
      <p className="onboarding-note">
        予定はこの端末にも保存され、オフラインでも見られます。
        <span className="onboarding-links">
          <a href="/privacy.html">プライバシー</a>
          <a href="/terms.html">規約</a>
        </span>
      </p>
    </section>
  );
}
