import { useCallback, useEffect, useState } from 'react'

export interface OfflineState {
  /** true の間、ツールバーに空枡+「オフライン」を出す(brand/README.md「枡オーナメント」節) */
  offline: boolean
  /** API fetch がネットワーク失敗/502 を返したときに呼ぶ */
  markOffline: () => void
  /** API fetch が(502 以外で)応答したときに呼ぶ */
  markOnline: () => void
}

/**
 * 「サーバーに接続できない」状態を表すフック。
 *
 * 判定は2系統: (1) navigator.onLine の online/offline イベント(ローカルの
 * ネットワークインターフェース有無)、(2) App.tsx 側の fetch 呼び出し結果
 * (markOffline/markOnline、ネットワーク失敗や 502 Bad Gateway を検知)。
 * サーバー個別の障害は (1) だけでは検知できない(インターフェース自体は
 * 生きている)ため、実際の API 疎通結果を一次情報源として併用する。
 *
 * このフック自身は fetch を発行しない — App.tsx の既存 fetch 経路に
 * markOffline/markOnline を薄く差し込んで使う。
 */
export function useOffline(): OfflineState {
  const [offline, setOffline] = useState(() => !navigator.onLine)

  useEffect(() => {
    function handleOnline() {
      setOffline(false)
    }
    function handleOffline() {
      setOffline(true)
    }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const markOffline = useCallback(() => setOffline(true), [])
  const markOnline = useCallback(() => setOffline(false), [])

  return { offline, markOffline, markOnline }
}
