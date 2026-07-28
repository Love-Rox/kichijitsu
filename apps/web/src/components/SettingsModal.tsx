import { useEffect, useRef, useState } from "react";
import type { AccountDTO, McpTokenCreateResponse, McpTokenDTO } from "@kichijitsu/shared";
import { mcpTokenCreatedLabel, mcpTokenLabel, mcpTokenLastUsedLabel } from "../sync/mcpTokens";
import { getGhPathOverride, isTauri, setGhPathOverride } from "../sync/githubProvider";
import { clearAppCaches } from "../sync/appCache";
import { getThemePref, setThemePref, type ThemePref } from "../sync/themePref";
import { useCloseOnOutsideOrEscape } from "../hooks/useCloseOnOutsideOrEscape";
import { BUILD_SHA, BUILD_TIME, formatBuildTime, getDesktopVersion } from "../version";
import "./SettingsModal.css";

export interface SettingsModalProps {
  accounts: AccountDTO[];
  /** 成功すれば解決、失敗すれば reject する。エラー表示はこのコンポーネント側(行ごとの確認 UI)が持つ */
  onDisconnectAccount: (accountId: string) => Promise<void>;
  onAddAccount: () => void;
  /**
   * tasks スコープ未付与のアカウント id 集合(docs/google-tasks.md、2026-07-20 追加の
   * .../auth/tasks スコープ)。GET /api/tasklists が 403 を返したアカウントが入る。
   * このセットに含まれる行に「タスクを表示するには再連携が必要です」ヒント + 再連携導線を出す。
   * undefined(呼び出し元が未対応)なら空集合扱いで何も出さない。
   */
  tasksScopeMissingAccounts?: ReadonlySet<string>;
  /**
   * 「再連携」ボタンから呼ぶ(App.tsx 側で /auth/login?add=1 へ遷移する)。同じ Google
   * アカウントを選び直せば prompt=consent で同意画面が再表示され tasks スコープが付く。
   * undefined なら再連携ボタンを出さない(ヒント文だけになる)。対象アカウントのメールを
   * 渡すので、App.tsx 側で login_hint に載せて Google 側にそのアカウントを事前選択させる。
   */
  onReconnectAccount?: (email: string) => void;
  /** カレンダーブロック設定オーバーレイ(docs/blocking.md)を開く導線。App.tsx 側で開閉制御する */
  onOpenBlockRules?: () => void;
  /**
   * GitHub 連携状態 (docs/github-integration.md フェーズ①Part B)。undefined/null は未連携
   * (「GitHub と連携」ボタンを出す)、文字列なら連携済みの login 名(「連携解除」導線を出す)
   */
  githubLogin?: string | null;
  /** GET /api/github/items が 401 (github_auth_expired) を返した場合に「再連携」を促す */
  githubAuthExpired?: boolean;
  /** 「GitHub と連携」/「再連携」ボタンから呼ぶ(App.tsx 側で /auth/github/login へ遷移する) */
  onConnectGitHub?: () => void;
  /** 「連携解除」確定で呼ぶ。成功すれば解決、失敗すれば reject する(onDisconnectAccount と同じ流儀) */
  onDisconnectGitHub?: () => Promise<void>;
  /**
   * MCP トークン管理 (docs/mcp.md Part A、2026-07-20)。undefined なら何も描画しない
   * (onConnectGitHub と同じ「呼び出し元が未対応なら黙って隠す」パターン)。
   */
  mcpTokens?: McpTokenDTO[];
  /** 発行ボタンから呼ぶ。成功すれば生トークン込みの行を解決する(表示は本コンポーネントが持つ) */
  onCreateMcpToken?: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  /** 行ごとの「失効」確定で呼ぶ。成功すれば解決、失敗すれば reject する */
  onDeleteMcpToken?: (id: string) => Promise<void>;
  /**
   * 「再同期」(全件取り直し、2026-07-29) の確定で呼ぶ。全同期が終わるまで解決せず、
   * 1つでも失敗すれば reject する(hooks/useCalendarSync.ts の runFullResync)。
   * undefined なら再同期の導線を出さない(他の任意セクションと同じ流儀)
   */
  onResync?: () => Promise<void>;
  onClose: () => void;
}

/**
 * 設定モーダル(UI 改善、2026-07-22、ユーザー要望)。ツールバーの「アカウント連携中」ボタンから
 * 開いていたアンカー式ポップオーバー(旧 CalendarSettingsPanel、300px の絶対配置)を、
 * BlockRulesOverlay/TimeReportOverlay と同じ「画面中央固定のモーダルダイアログ」に格上げした。
 * アンカー位置計算(ツールバーのボタン位置に追従させる)が不要になったぶん実装は単純になり、
 * 幅の制約(旧 300px)から解放されて各セクションを見出し付きでゆったり並べられる。
 *
 * 中身は CalendarSettingsPanel の内容をそのまま移植 ―― ロジック・子コンポーネント
 * (AccountDisconnectControl/GitHubDisconnectControl/McpTokensSection 以下)は無変更、
 * 「アカウント」「GitHub」「MCP トークン」「カレンダーブロック」の4セクションに
 * 見出し(BlockRulesOverlay と同じ .settings-modal-section-title)を付けて区切っただけ。
 * カレンダーごとの表示 ON/OFF は引き続きここには無い(カレンダーナビゲーション増分1で
 * CalendarPane.tsx へ移設済み ―― 「選択=左ペイン / 連携管理=設定モーダル」の役割分担は不変)。
 *
 * 開閉: BlockRulesOverlay/TimeReportOverlay と同じ useCloseOnOutsideOrEscape で
 * 外側クリック・Escape に対応する(App.tsx 側の個別リスナーは不要になった)。
 */
export function SettingsModal({
  accounts,
  onDisconnectAccount,
  onAddAccount,
  tasksScopeMissingAccounts,
  onReconnectAccount,
  onOpenBlockRules,
  githubLogin,
  githubAuthExpired,
  onConnectGitHub,
  onDisconnectGitHub,
  mcpTokens,
  onCreateMcpToken,
  onDeleteMcpToken,
  onResync,
  onClose,
}: SettingsModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideOrEscape(true, cardRef, onClose);

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
    <div className="settings-modal-backdrop">
      <div
        className="settings-modal-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="設定"
      >
        <div className="settings-modal-header">
          <span className="settings-modal-title">設定</span>
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <section className="settings-modal-section">
          <h3 className="settings-modal-section-title">アカウント</h3>
          {accounts.length === 0 && (
            <p className="settings-modal-empty">連携中のアカウントがありません</p>
          )}
          {accounts.map((account) => (
            <div className="settings-modal-account" key={account.id}>
              <div className="settings-modal-account-header">{account.email}</div>
              <AccountDisconnectControl accountId={account.id} onDisconnect={onDisconnectAccount} />
              {tasksScopeMissingAccounts?.has(account.id) && (
                <p className="settings-modal-tasks-scope-missing">
                  タスクを表示するには再連携が必要です。
                  {onReconnectAccount && (
                    <button
                      type="button"
                      className="settings-modal-text-btn"
                      onClick={() => onReconnectAccount(account.email)}
                    >
                      再連携
                    </button>
                  )}
                </p>
              )}
            </div>
          ))}
          <button type="button" className="settings-modal-add-account" onClick={onAddAccount}>
            + アカウントを追加
          </button>
        </section>

        {/*
         * GitHub 連携 (docs/github-integration.md フェーズ①Part B)。Google アカウントとは
         * 独立した連携なので独立したセクションにする。onConnectGitHub が無ければ
         * (呼び出し元が未対応)何も描画しない(旧 CalendarSettingsPanel と同じパターン)
         */}
        {onConnectGitHub && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">GitHub</h3>
            {githubLogin ? (
              <div className="settings-modal-github-connected">
                <span className="settings-modal-github-login">@{githubLogin}</span>
                {onDisconnectGitHub && (
                  <GitHubDisconnectControl onDisconnect={onDisconnectGitHub} />
                )}
              </div>
            ) : (
              <button
                type="button"
                className="settings-modal-add-account"
                onClick={onConnectGitHub}
              >
                + GitHub と連携
              </button>
            )}
            {githubAuthExpired && (
              <p className="settings-modal-github-expired">
                GitHub の認可が切れました。
                <button type="button" className="settings-modal-text-btn" onClick={onConnectGitHub}>
                  再連携
                </button>
              </p>
            )}
            {/* デスクトップ(Tauri)のみ: gh のパスを手動指定できる。GUI 起動で PATH に gh が無く、
                自動検出(resolve_gh_path)でも拾えない非標準の場所に置いている人向け。 */}
            {isTauri() && <GhPathOverrideControl />}
          </section>
        )}

        {/*
         * MCP トークン (docs/mcp.md Part A、2026-07-20)。mcpTokens が undefined
         * (呼び出し元が未対応) なら何も描画しない(GitHub セクションと同じパターン)
         */}
        {mcpTokens && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">MCP トークン</h3>
            <McpTokensSection
              tokens={mcpTokens}
              onCreate={onCreateMcpToken}
              onDelete={onDeleteMcpToken}
            />
          </section>
        )}

        {/*
         * カレンダーブロック (docs/blocking.md)。設定モーダルからは既存の BlockRulesOverlay を
         * 開く入口だけを置く(ルール一覧・作成フォームはそちらに任せる ―― 設定モーダルの
         * 幅に収める必要が無くなった今も、二重に持たせず単一の入口を保つ)。
         */}
        {onOpenBlockRules && (
          <section className="settings-modal-section">
            <h3 className="settings-modal-section-title">カレンダーブロック</h3>
            <p className="settings-modal-section-desc">
              選んだカレンダーの予定を、別のカレンダーに「予定あり」として自動でコピーします。
            </p>
            <button type="button" className="settings-modal-add-account" onClick={onOpenBlockRules}>
              予定のブロックを設定
            </button>
          </section>
        )}

        {/*
         * テーマ (ダークモード切替、ユーザー要望、2026-07-26)。連携系のセクションとは
         * 性質が違う「見た目の設定」なので最後に置く。呼び出し元の props に依存しない
         * (localStorage だけで完結する) ため、他セクションと違い常に描画される。
         */}
        <section className="settings-modal-section">
          <h3 className="settings-modal-section-title" id="settings-theme-title">
            テーマ
          </h3>
          <ThemeControl />
        </section>

        {/*
         * Google 審査要件の導線(プライバシーポリシー・規約)。旧 CalendarSettingsPanel と
         * 同じくモーダル下部に集約する。
         */}
        <div className="settings-modal-legal">
          <a href="/privacy.html">プライバシー</a>
          <a href="/terms.html">規約</a>
        </div>

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

        {/*
         * キャッシュ削除 (ユーザー要望、2026-07-26)。上のビルド情報で「古いビルドを
         * 見ている」と気づいた人がその場で直せるよう、すぐ下に脱出口を置く。
         */}
        <CacheClearControl />

        {/*
         * 再同期 (ユーザー要望、2026-07-29)。キャッシュ削除と並ぶ「困ったときの脱出口」で、
         * 住み分けは 表示が古い → キャッシュ削除 (表示用ファイルの入れ替え) /
         * 予定の中身がおかしい → 再同期 (予定データの取り直し)。並べて置くことで
         * 説明文どうしを読み比べて選べるようにしている。
         */}
        {onResync && <ResyncControl onResync={onResync} />}
      </div>
    </div>
  );
}

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
function ConfirmActionControl({
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
function CacheClearControl() {
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

/**
 * 「再同期」導線 (ユーザー要望、2026-07-29)。キャッシュ削除の隣に置く姉妹の脱出口で、
 * 住み分けは「表示が古い → キャッシュ削除 / 予定の中身がおかしい → 再同期」。
 *
 * 効く理由: アプリ外 (Google カレンダー本体や他の端末) で消された予定の削除通知を一度でも
 * 取りこぼすと、Google の syncToken は先へ進んでしまい同じ通知は二度と来ないため、増分同期
 * (ツールバーの「同期」) では残骸を掃除できない。全同期の応答だけが
 * applyFullSyncAtomic (sync/applySync.ts) によるローカル複製の総入れ替えを起こす。
 *
 * 破棄と再取得を分けず1操作にしてあるのは、押した後にもう一度「同期」を押させないため
 * (hooks/useCalendarSync.ts の runFullResync が全同期まで走り切る)。
 */
function ResyncControl({ onResync }: { onResync: () => Promise<void> }) {
  return (
    <div className="settings-modal-cache">
      <p className="settings-modal-section-desc">
        {"予定の中身がおかしいときに使います。表示中のカレンダーの予定を Google から全件取り直すため、" +
          "通信量と時間がかかります。作業実績・連携アカウント・設定は消えません。"}
      </p>
      <ConfirmActionControl
        triggerLabel="予定を再同期"
        question="予定を全件取り直しますか？"
        confirmLabel="再同期する"
        errorLabel="再同期失敗"
        successLabel="再同期しました"
        logLabel="full resync"
        onConfirm={onResync}
      />
    </div>
  );
}

/**
 * アカウント1件ぶんの「連携解除」導線。インライン2段階確認 (ConfirmActionControl) を、
 * 行ごとに独立したローカル state として持つ(アカウントが複数あっても他の行に影響しない)。
 * 成功時に idle へ戻さないのは、呼び出し元 (App.tsx) が accounts から本行ごと除去するため。
 */
function AccountDisconnectControl({
  accountId,
  onDisconnect,
}: {
  accountId: string;
  onDisconnect: (accountId: string) => Promise<void>;
}) {
  return (
    <ConfirmActionControl
      triggerLabel="連携解除"
      question="連携解除しますか？"
      confirmLabel="解除する"
      errorLabel="解除失敗"
      logLabel="account disconnect"
      onConfirm={() => onDisconnect(accountId)}
    />
  );
}

/**
 * GitHub 連携の「連携解除」導線。AccountDisconnectControl と全く同じインライン2段階確認だが、
 * こちらは対象を1つに固定できる(GitHub 連携はプロファイルにつき高々1件)ため accountId を取らない。
 */
function GitHubDisconnectControl({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  return (
    <ConfirmActionControl
      triggerLabel="連携解除"
      question="連携解除しますか？"
      confirmLabel="解除する"
      errorLabel="解除失敗"
      logLabel="GitHub disconnect"
      onConfirm={onDisconnect}
    />
  );
}

/**
 * gh のパス上書き(デスクトップ=Tauri のみ、GitHub セクション内)。ローカル gh CLI 経由で GitHub
 * データを取るデスクトップ版で、GUI 起動時に PATH へ gh が無く、自動検出(Rust の resolve_gh_path)
 * でも拾えない非標準の場所(nvm/asdf 配下・独自インストール等)に gh を置いている人向けの手動指定。
 * 値は localStorage(getGhPathOverride/setGhPathOverride)に保存し、次の GitHub 取得(再読み込み・
 * 更新ボタン)から効く。空にすると自動検出へ戻る。
 */
function GhPathOverrideControl() {
  const [value, setValue] = useState(() => getGhPathOverride());
  const [saved, setSaved] = useState(false);

  const save = () => {
    setGhPathOverride(value);
    setSaved(true);
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
          }}
        />
        <button type="button" className="settings-modal-text-btn" onClick={save}>
          保存
        </button>
      </div>
      <p className="settings-modal-gh-path-hint">
        {saved
          ? "保存しました。再読み込み(⌘R)で GitHub 表示に反映されます。"
          : "GitHub が表示されないとき、gh の場所を手動指定できます。空欄で自動検出に戻ります。"}
      </p>
    </div>
  );
}

/** テーマ3択の表示ラベル。値の正は sync/themePref.ts の ThemePref */
const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "auto", label: "自動" },
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
];

/**
 * テーマ3択 (自動 / ライト / ダーク、ユーザー要望、2026-07-26)。
 *
 * 保存ボタンは持たず、選んだ瞬間に setThemePref が localStorage への保存と
 * <html data-theme> の書き換えを両方行う ―― 配色の反映は theme.css (color-scheme +
 * light-dark()) が担うので、React 側に再描画すべきものは何も無い。
 *
 * したがって値の正は localStorage であり、ここの useState は「いま何にチェックが
 * 入っているか」を描くためだけのローカルな写し (GhPathOverrideControl と同じ流儀)。
 * App.tsx に state を持ち上げると二重管理になるだけで得が無いので持ち上げていない。
 *
 * ラジオグループにしたのは3択が排他だから ―― ネイティブの <input type="radio"> を
 * 同じ name で並べれば、矢印キーでの移動と読み上げ時の「n個中m番目・選択済み」が
 * ブラウザ標準で手に入る。
 */
function ThemeControl() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());

  return (
    <>
      <p className="settings-modal-section-desc">
        「自動」は、お使いの端末(OS)の外観設定に合わせて自動で切り替わります。
      </p>
      <div
        className="settings-modal-theme-options"
        role="radiogroup"
        aria-labelledby="settings-theme-title"
      >
        {THEME_OPTIONS.map((option) => (
          <label className="settings-modal-theme-option" key={option.value}>
            <input
              type="radio"
              name="settings-theme"
              value={option.value}
              checked={pref === option.value}
              onChange={() => {
                setThemePref(option.value);
                setPref(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
    </>
  );
}

/**
 * MCP トークン (docs/mcp.md Part A、2026-07-20) セクション本体。一覧 + 発行導線を持つ。
 * 「発行直後だけ生値を表示する」状態はこのコンポーネントがローカルに持つ — サーバーは
 * 二度と生値を返さないため、閉じたら (state をクリアしたら) 本当に消える。
 * 見出し(「MCP トークン」)は呼び出し側 (SettingsModal) の settings-modal-section-title が
 * 担うため、旧 CalendarSettingsPanel と違いここでは自前の見出しを持たない。
 */
function McpTokensSection({
  tokens,
  onCreate,
  onDelete,
}: {
  tokens: McpTokenDTO[];
  onCreate?: (label: string | undefined) => Promise<McpTokenCreateResponse>;
  onDelete?: (id: string) => Promise<void>;
}) {
  return (
    <div className="settings-modal-mcp">
      {tokens.length === 0 ? (
        <p className="settings-modal-empty">発行済みのトークンはありません</p>
      ) : (
        <ul className="settings-modal-mcp-list">
          {tokens.map((token) => (
            <li className="settings-modal-mcp-item" key={token.id}>
              <div className="settings-modal-mcp-item-main">
                <span className="settings-modal-mcp-item-label">{mcpTokenLabel(token)}</span>
                <span className="settings-modal-mcp-item-meta">
                  発行: {mcpTokenCreatedLabel(token)} / 最終利用: {mcpTokenLastUsedLabel(token)}
                </span>
              </div>
              {onDelete && <McpTokenDeleteControl tokenId={token.id} onDelete={onDelete} />}
            </li>
          ))}
        </ul>
      )}
      {onCreate && <McpTokenCreateControl onCreate={onCreate} />}
    </div>
  );
}

/**
 * トークン1件の「失効」導線。AccountDisconnectControl/GitHubDisconnectControl と
 * 全く同じインライン2段階確認 (ConfirmActionControl) を、対象トークン id だけ差し替えて使う。
 * 成功時は呼び出し元 (App.tsx) が mcpTokens から本行ごと除去する。
 */
function McpTokenDeleteControl({
  tokenId,
  onDelete,
}: {
  tokenId: string;
  onDelete: (id: string) => Promise<void>;
}) {
  return (
    <ConfirmActionControl
      triggerLabel="失効"
      question="失効しますか？"
      confirmLabel="失効する"
      errorLabel="失効失敗"
      logLabel="MCP token delete"
      onConfirm={() => onDelete(tokenId)}
    />
  );
}

type McpCreateState =
  | { kind: "idle" }
  | { kind: "entering-label"; label: string }
  | { kind: "creating" }
  | { kind: "created"; result: McpTokenCreateResponse }
  | { kind: "error" };

/**
 * トークン発行フォーム。「トークンを発行」ボタン → インラインのラベル入力 → 発行 →
 * 生トークンを一度だけ表示、の流れ。「閉じる」を押すとローカル state (result) を
 * 破棄するだけ — サーバーから生値を取り直す経路は存在しない (二度と表示されない)。
 */
function McpTokenCreateControl({
  onCreate,
}: {
  onCreate: (label: string | undefined) => Promise<McpTokenCreateResponse>;
}) {
  const [state, setState] = useState<McpCreateState>({ kind: "idle" });

  if (state.kind === "created") {
    const { result } = state;
    return (
      <div className="settings-modal-mcp-created">
        <p className="settings-modal-mcp-warning">
          この値は二度と表示されません。今すぐコピーしてください。
        </p>
        <div className="settings-modal-mcp-token-row">
          <code className="settings-modal-mcp-token-value">{result.token}</code>
          <button
            type="button"
            className="settings-modal-text-btn"
            onClick={() => {
              navigator.clipboard.writeText(result.token).catch((err) => {
                console.error("kichijitsu: clipboard write failed", err);
              });
            }}
          >
            コピー
          </button>
        </div>
        {/*
         * MCP エンドポイントは公式ホスト名を焼き込まず、いま開いているインスタンスの
         * origin から組み立てる (2026-07-26)。セルフホストした人の設定画面に
         * 公式インスタンスの URL が出ると、エージェントを他人のサーバーへ繋がせてしまう。
         * デスクトップ版はリモート URL を読み込む方式なので、origin は
         * そのアプリが指しているインスタンスと一致する。
         */}
        <p className="settings-modal-mcp-hint">
          Claude 等の MCP クライアント設定で、この値を{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> として{" "}
          <code>{`${window.location.origin}/mcp`}</code> に登録してください。
        </p>
        <button
          type="button"
          className="settings-modal-text-btn"
          onClick={() => setState({ kind: "idle" })}
        >
          閉じる
        </button>
      </div>
    );
  }

  if (state.kind === "entering-label" || state.kind === "creating") {
    const disabled = state.kind === "creating";
    return (
      <div className="settings-modal-mcp-form">
        <input
          type="text"
          className="settings-modal-mcp-label-input"
          placeholder="ラベル(任意)"
          value={state.kind === "entering-label" ? state.label : ""}
          disabled={disabled}
          onChange={(e) => setState({ kind: "entering-label", label: e.target.value })}
        />
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={disabled}
          onClick={() => {
            const label = state.kind === "entering-label" ? state.label.trim() : "";
            setState({ kind: "creating" });
            onCreate(label.length > 0 ? label : undefined)
              .then((result) => setState({ kind: "created", result }))
              .catch((err) => {
                console.error("kichijitsu: MCP token create failed", err);
                setState({ kind: "error" });
              });
          }}
        >
          発行
        </button>
        <button
          type="button"
          className="settings-modal-text-btn"
          disabled={disabled}
          onClick={() => setState({ kind: "idle" })}
        >
          キャンセル
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="settings-modal-add-account"
        onClick={() => setState({ kind: "entering-label", label: "" })}
      >
        + トークンを発行
      </button>
      {state.kind === "error" && <span className="settings-modal-error">発行失敗</span>}
    </div>
  );
}
