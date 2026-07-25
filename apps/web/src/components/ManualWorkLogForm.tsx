import { useEffect, useMemo, useState } from "react";
import type { GitHubRepoIssue, GitHubRepoRef, WorkLogCreateRequest } from "@kichijitsu/shared";
import {
  buildWorkLogCreateRequest,
  collectRepoOwners,
  combineOrgRepo,
  reposForOwner,
  validateWorkLogEntryForm,
  WORK_LOG_ENTRY_ERROR_MESSAGES,
  type WorkLogEntryFormInput,
} from "../sync/workLogEntry";

/**
 * 実績の手動記録フォーム。2026-07-25 のファイル分割(リファクタ フェーズ1b)で GitHubPane.tsx から
 * 切り出した ―― props の形・クラス名・挙動は無変更。CSS(GitHubPane.css)の import は
 * GitHubPane.tsx 側の1箇所のまま(PaneSection.tsx のコメント参照)。
 */
export interface ManualWorkLogFormProps {
  orgCandidates: string[];
  repoCandidates: string[];
  timeZone: string;
  onCreate: (req: WorkLogCreateRequest) => Promise<void>;
  fetchRepos: () => Promise<GitHubRepoRef[]>;
  fetchRepoIssues: (repo: string) => Promise<GitHubRepoIssue[]>;
}

/** 非同期取得の状態機械(repos / repo-issues 共通)。 */
type LoadState = "idle" | "loading" | "loaded" | "error";

/**
 * 手動記録フォーム(旧 WorkLogModal から移設、2026-07-25)。サーバーの WorkLogCreateRequest は
 * repo 1フィールドのみだが、UI では org / repo / issue を実データのカスケードプルダウンにする:
 *   - org select: repo 一覧の owner を重複排除して昇順(sync/workLogEntry.ts の collectRepoOwners)。
 *   - repo select: 選択中 org の repo を昇順(同 reposForOwner)。
 *   - issue/PR select: repo 選択時にその repo の open issue/PR を取得して表示。
 * 送信時は combineOrgRepo で "org/repo" へ結合し、issue は選んだ number を issueRef に入れる
 * (送信ボディの形は変えない、workLogEntry.ts のコメント参照)。
 *
 * repo 一覧はセクションを開いた初回に一度だけ取得する。取得できない(未連携・gh 未ログイン・
 * オフライン等)ときは、org/repo/issue を datalist 付きテキストで手入力できるフォールバックへ
 * 切り替える — プルダウンの元データが無くても実績記録という主機能を止めないため。issue の取得
 * 失敗も同様に番号のテキスト手入力へフォールバックする。
 *
 * レイアウトは 420px の右ペインに合わせて1列縦積み(モーダル時代の org/repo・開始/終了の
 * 横並びは廃止 ―― datetime-local は最小幅が大きく、420px の半分では入力欄が潰れるため)。
 */
export function ManualWorkLogForm({
  orgCandidates,
  repoCandidates,
  timeZone,
  onCreate,
  fetchRepos,
  fetchRepoIssues,
}: ManualWorkLogFormProps) {
  const [org, setOrg] = useState("");
  const [repo, setRepo] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [agent, setAgent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // repo 一覧(プルダウンの元データ)。セクションを開いた初回に一度だけ取得する。
  const [repos, setRepos] = useState<GitHubRepoRef[]>([]);
  const [reposState, setReposState] = useState<LoadState>("idle");
  // 選択中 repo の open issue/PR。repo 選択が変わるたびに取り直す。
  const [issues, setIssues] = useState<GitHubRepoIssue[]>([]);
  const [issuesState, setIssuesState] = useState<LoadState>("idle");

  useEffect(() => {
    let cancelled = false;
    setReposState("loading");
    fetchRepos()
      .then((list) => {
        if (cancelled) return;
        setRepos(list);
        setReposState("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("kichijitsu: repo 一覧の取得に失敗(手入力にフォールバック)", err);
        setReposState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRepos]);

  // プルダウンを使えるのは「取得成功かつ1件以上」のときだけ。それ以外(取得失敗・0件)は
  // テキスト手入力へフォールバックする。
  const usePulldown = reposState === "loaded" && repos.length > 0;

  const orgOptions = useMemo(() => collectRepoOwners(repos), [repos]);
  const repoOptions = useMemo(() => reposForOwner(repos, org), [repos, org]);

  // repo が確定したら issue/PR を取得する(プルダウン時のみ)。org か repo が変われば取り直す。
  useEffect(() => {
    if (!usePulldown || !org || !repo) {
      setIssues([]);
      setIssuesState("idle");
      return;
    }
    let cancelled = false;
    setIssuesState("loading");
    setIssues([]);
    fetchRepoIssues(`${org}/${repo}`)
      .then((list) => {
        if (cancelled) return;
        setIssues(list);
        setIssuesState("loaded");
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("kichijitsu: issue/PR 一覧の取得に失敗(番号手入力にフォールバック)", err);
        setIssuesState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [usePulldown, org, repo, fetchRepoIssues]);

  function resetForm() {
    setOrg("");
    setRepo("");
    setIssueRef("");
    setStartLocal("");
    setEndLocal("");
    setAgent("");
    setIssues([]);
    setIssuesState("idle");
  }

  function handleSave() {
    const input: WorkLogEntryFormInput = {
      repo: combineOrgRepo(org, repo),
      issueRef,
      startLocal,
      endLocal,
      agent,
    };
    const validationError = validateWorkLogEntryForm(input, timeZone);
    if (validationError) {
      setError(WORK_LOG_ENTRY_ERROR_MESSAGES[validationError]);
      return;
    }
    setSubmitting(true);
    setError(null);
    onCreate(buildWorkLogCreateRequest(input, timeZone))
      .then(() => resetForm())
      .catch((err) => {
        console.error("kichijitsu: work log create failed", err);
        setError("追加に失敗しました。しばらくしてから試してください");
      })
      .finally(() => setSubmitting(false));
  }

  // issue/PR の入力領域。プルダウン時は取得状態に応じて select / 番号手入力を出し分ける。
  function renderIssueField() {
    // フォールバック(repos が取れない): 番号を直接手入力。
    if (!usePulldown) {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR番号(任意)</span>
          <input
            type="text"
            className="github-pane-input"
            placeholder="42"
            value={issueRef}
            disabled={submitting}
            onChange={(e) => setIssueRef(e.target.value)}
          />
        </div>
      );
    }
    if (!org || !repo) {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR(任意)</span>
          <select className="github-pane-input" disabled value="">
            <option value="">repo を選ぶと一覧が出ます</option>
          </select>
        </div>
      );
    }
    if (issuesState === "loading") {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR(任意)</span>
          <select className="github-pane-input" disabled value="">
            <option value="">読み込み中…</option>
          </select>
        </div>
      );
    }
    // 取得失敗 or 0件: 番号を直接手入力できるフォールバック。
    if (issuesState === "error" || issues.length === 0) {
      return (
        <div className="github-pane-field">
          <span className="github-pane-label">issue/PR番号(任意)</span>
          <input
            type="text"
            className="github-pane-input"
            placeholder="42"
            value={issueRef}
            disabled={submitting}
            onChange={(e) => setIssueRef(e.target.value)}
          />
          <span className="github-pane-hint">
            {issuesState === "error"
              ? "一覧を取得できませんでした。番号を直接入力できます"
              : "open な issue/PR はありません。番号を直接入力できます"}
          </span>
        </div>
      );
    }
    // 取得成功: プルダウン。
    return (
      <div className="github-pane-field">
        <span className="github-pane-label">issue/PR(任意)</span>
        <select
          className="github-pane-input"
          value={issueRef}
          disabled={submitting}
          onChange={(e) => setIssueRef(e.target.value)}
        >
          <option value="">(選択しない)</option>
          {issues.map((i) => (
            <option key={`${i.type}-${i.number}`} value={String(i.number)}>
              {i.type === "pr" ? "PR" : "Issue"} #{i.number} {i.title}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="github-pane-form">
      {reposState === "loading" && (
        <span className="github-pane-hint">リポジトリ一覧を読み込み中…</span>
      )}
      {reposState === "error" && (
        <span className="github-pane-hint">
          リポジトリ一覧を取得できませんでした。org / repo は手入力してください
        </span>
      )}

      {usePulldown ? (
        <>
          <div className="github-pane-field">
            <span className="github-pane-label">org</span>
            <select
              className="github-pane-input"
              value={org}
              disabled={submitting}
              onChange={(e) => {
                setOrg(e.target.value);
                // org を変えたら repo / issue の選択はリセットする(整合性のため)。
                setRepo("");
                setIssueRef("");
              }}
            >
              <option value="">org を選択</option>
              {orgOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="github-pane-field">
            <span className="github-pane-label">repo</span>
            <select
              className="github-pane-input"
              value={repo}
              disabled={submitting || !org}
              onChange={(e) => {
                setRepo(e.target.value);
                setIssueRef("");
              }}
            >
              <option value="">{org ? "repo を選択" : "先に org を選択"}</option>
              {repoOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <>
          <div className="github-pane-field">
            <span className="github-pane-label">org</span>
            <input
              type="text"
              className="github-pane-input"
              list="github-pane-org-candidates"
              placeholder="owner"
              value={org}
              disabled={submitting}
              onChange={(e) => setOrg(e.target.value)}
            />
            <datalist id="github-pane-org-candidates">
              {orgCandidates.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>
          <div className="github-pane-field">
            <span className="github-pane-label">repo</span>
            <input
              type="text"
              className="github-pane-input"
              list="github-pane-repo-candidates"
              placeholder="repo"
              value={repo}
              disabled={submitting}
              onChange={(e) => setRepo(e.target.value)}
            />
            <datalist id="github-pane-repo-candidates">
              {repoCandidates.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>
        </>
      )}

      {renderIssueField()}

      <div className="github-pane-field">
        <span className="github-pane-label">開始</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={startLocal}
          disabled={submitting}
          onChange={(e) => setStartLocal(e.target.value)}
        />
      </div>
      <div className="github-pane-field">
        <span className="github-pane-label">終了</span>
        <input
          type="datetime-local"
          className="github-pane-input"
          value={endLocal}
          disabled={submitting}
          onChange={(e) => setEndLocal(e.target.value)}
        />
      </div>

      <div className="github-pane-field">
        <span className="github-pane-label">agent(任意、既定は manual)</span>
        <input
          type="text"
          className="github-pane-input"
          placeholder="manual"
          value={agent}
          disabled={submitting}
          onChange={(e) => setAgent(e.target.value)}
        />
      </div>

      <div className="github-pane-submit-row">
        <button
          type="button"
          className="github-pane-save-btn"
          disabled={submitting}
          onClick={handleSave}
        >
          {submitting ? "追加中…" : "実績を追加"}
        </button>
        {error && <span className="github-pane-error">{error}</span>}
      </div>
    </div>
  );
}
