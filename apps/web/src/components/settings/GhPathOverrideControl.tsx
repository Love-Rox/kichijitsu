/**
 * 設定モーダル「GitHub」セクション内の、gh バイナリのパス手動指定 (デスクトップ=Tauri のみ) を
 * 担当するファイル。GitHub セクション本体 (連携状態の表示・解除) とは寿命も関心も別なので
 * 独立させてあるが、DOM 上は GitHubSection の中に置かれる。
 */
import { useState } from "react";
import { getGhPathOverride, saveGhPathOverride } from "../../sync/githubProvider";

/**
 * gh のパス上書き(デスクトップ=Tauri のみ、GitHub セクション内)。ローカル gh CLI 経由で GitHub
 * データを取るデスクトップ版で、GUI 起動時に PATH へ gh が無く、自動検出(Rust の resolve_gh_path)
 * でも拾えない非標準の場所(nvm/asdf 配下・独自インストール等)に gh を置いている人向けの手動指定。
 * 値は localStorage(getGhPathOverride/setGhPathOverride)に保存し、次の GitHub 取得(再読み込み・
 * 更新ボタン)から効く。空にすると自動検出へ戻る。
 *
 * 保存時に検証する(2026-07-30): 以前は不正なパスでも保存でき、拒否されるのは後の gh 実行時
 * だったため「GitHub の予定・実績が出ない」という分かりにくい形でしか現れなかった。今は
 * saveGhPathOverride が保存の手前で弾き、理由をその場に出す。判定と文言はすべて
 * sync/githubProvider.ts 側が持ち、ここは「頼む・返ってきた理由を出す」だけ。
 */
export function GhPathOverrideControl() {
  const [value, setValue] = useState(() => getGhPathOverride());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    // 検証にデスクトップシェルへの問い合わせ(存在確認)が入るため非同期。
    void saveGhPathOverride(value).then((message) => {
      setError(message);
      setSaved(message === null);
    });
  };

  return (
    <div className="settings-modal-gh-path">
      <label className="settings-modal-gh-path-label" htmlFor="settings-gh-path">
        gh のパス(任意)
      </label>
      <div className="settings-modal-gh-path-row">
        <input
          id="settings-gh-path"
          type="text"
          className="settings-modal-gh-path-input"
          placeholder="空=自動検出 (例: /opt/homebrew/bin/gh)"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
            setError(null);
          }}
        />
        <button type="button" className="settings-modal-text-btn" onClick={save}>
          保存
        </button>
      </div>
      {/* 保存ボタンの押下で内容が入れ替わる場所なので、読み上げにも変化が伝わるようにする。
          拒否の朱色は他の失敗表示と同じ .settings-modal-error を使う(意匠を増やさない)。 */}
      <p className="settings-modal-gh-path-hint" aria-live="polite">
        {error ? (
          <span className="settings-modal-error">{error}</span>
        ) : saved ? (
          "保存しました。再読み込み(⌘R)で GitHub 表示に反映されます。"
        ) : (
          "GitHub が表示されないとき、gh の場所を手動指定できます。空欄で自動検出に戻ります。"
        )}
      </p>
    </div>
  );
}
