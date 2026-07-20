import { useEffect, useRef, useState } from "react";

export interface MasuVisibleState {
  /** true の間だけ呼び出し側は MasuIndicator を描画してよい */
  visible: boolean;
  /** true の間、呼び出し側は fade-out 用の CSS クラス(.masu-indicator--fading)を添えるとよい */
  fading: boolean;
}

const FADE_MS = 200;

/**
 * MasuIndicator の「止め方」を扱う小さなフック。
 *
 * brand/README.md の理想は「現在の周回(1820ms)を完走してからフェードアウト」
 * (各枡の animationiteration を拾う実装)。しかしこのアプリでの利用箇所
 * (同期ボタン・初回ロードのオーバーレイ、apps/web/src/App.tsx)はどちらも
 * 「ユーザー操作やデータ到着に紐づく一回きりの停止」で、周回の完走を待つと
 * 最大 1.8 秒 UI が固まって見えるリスクの方が「ぶつ切り」よりも目立つと判断し、
 * ここでは opacity 200ms の単純フェードのみで妥協している。
 *
 * active が true の間は visible=true。false になった瞬間は visible を保ったまま
 * fading=true にし、FADE_MS 後に visible=false にする(=呼び出し側がアンマウントしてよい)。
 */
export function useMasuVisible(active: boolean): MasuVisibleState {
  const [visible, setVisible] = useState(active);
  const [fading, setFading] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (active) {
      setVisible(true);
      setFading(false);
      return;
    }
    setFading(true);
    const timeoutId = window.setTimeout(() => {
      // タイムアウト発火までの間に再び active に戻っていたら消さない
      if (!activeRef.current) setVisible(false);
    }, FADE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [active]);

  return { visible, fading };
}
