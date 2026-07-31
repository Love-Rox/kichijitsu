/**
 * 設定モーダル下部の「いま見ているビルド」表示と、デスクトップ版だけの再読み込み案内を
 * 担当するファイル。見出し付きの <section> ではなくフッターの2行なので、
 * DOM をそのまま保つため Fragment で 2 つの <p> を並べて返す。
 *
 * デスクトップ版のバージョン取得 (window.__TAURI__ 経由) もこのファイルの関心なので、
 * SettingsModal 側から state/effect ごとここへ移してある。
 */
import { useEffect, useState } from "react";
import { isTauri } from "../../sync/githubProvider";
import { BUILD_SHA, BUILD_TIME, formatBuildTime, getDesktopVersion } from "../../version";

export function BuildInfoFooter() {
  // デスクトップアプリのバージョン (best-effort、docs/desktop.md 増分2b の gh_api と同じ
  // window.__TAURI__ 経由)。ブラウザ/PWA では常に null のままで、web のビルド情報だけ出す。
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDesktopVersion()
      .then((version) => {
        if (!cancelled) setDesktopVersion(version);
      })
      .catch((err) => {
        // getDesktopVersion 自体は内部で catch して null に丸めるため実際には reject
        // しないが、linter (no-floating-promises) 対策として形だけ持たせる。
        console.error("kichijitsu: getDesktopVersion unexpectedly rejected", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {/*
       * ビルド番号表示 (ユーザー要望、2026-07-22)。リモート URL 方式のデスクトップアプリで
       * webview がキャッシュ由来の古いビルドを表示し続けても気づけるよう、
       * 「いま見ているビルド」を確認できる控えめな表示をフッターに置く (version.ts 参照)。
       */}
      <p className="settings-build-info">
        {desktopVersion && `アプリ v${desktopVersion} · `}
        ビルド {BUILD_SHA} · {formatBuildTime(BUILD_TIME)}
      </p>

      {/*
       * デスクトップ版だけの一言 (2026-07-29、ユーザー要望)。デスクトップ版はリモート URL を
       * 読み込む方式 (apps/desktop/src-tauri/src/lib.rs 冒頭) なので、web を再デプロイしても
       * webview を読み直すまで反映されない ―― 上のビルド情報を見て「古い」と気づいた人が
       * 次に何をすればよいかが分かるよう、ビルド情報のすぐ下に置く。ブラウザ/PWA には
       * 出さない(そちらは通常のリロードで済み、⌘R もトレイも文脈が違うため)。
       */}
      {isTauri() && (
        <p className="settings-build-hint">
          最新にするには ⌘R(またはトレイの「再読み込み」)で読み直してください。
        </p>
      )}
    </>
  );
}
