/**
 * OAuth 却下時の案内文言を組み立てる純ロジック(2026-08-08)。
 *
 * apps/sync (routes/auth.ts / routes/github-auth.ts) は連携を拒否したとき `?auth_error=...`
 * を付けて APP_URL へ 302 する。ところがこれまで web 側にそれを読む場所が無く、弾かれても
 * トップ画面に戻るだけで何も表示されない事故が本番で起きた。components/toolbarErrorNotes.ts と
 * 同じ理由(この web アプリにはコンポーネントテストの土台が無いため、React に依存しない .ts に
 * 切り出してテストで固定する)でここを分離する。
 */

/**
 * `window.location.search` 相当の文字列から `auth_error` の値を取り出す。
 * 無い/空文字なら null(URLSearchParams はキーがあっても値が空文字のことがあるため、
 * 「見つかったが空」も「見つからなかった」も同じ「表示するものが無い」として扱う)。
 */
export function readAuthErrorCode(search: string): string | null {
  const value = new URLSearchParams(search).get("auth_error");
  return value ? value : null;
}

/**
 * auth_error のコードを日本語の案内文言に変換する。
 *
 * 既知の3コード(サーバー側で送信元が固定されている auth.ts の insufficient_scope/not_invited、
 * github-auth.ts の login_required)は専用の文言を返す。
 *
 * それ以外の未知コードは **絶対に null を返さない** ―― 今回のバグの本質は「サーバーが理由を
 * 送っているのにクライアントが黙って捨てた」ことであり、未知コードを握り潰すと同じ沈黙が
 * 再発する。具体的には github-auth.ts:74 の `github_oauth_error: <GitHub 側の値>` /
 * `github_token_exchange_failed` / `github_user_fetch_failed` のように値が可変・可拡張な
 * コードや、将来サーバー側に新しいコードを足したときに、web 側を直し忘れても「コードを含む
 * 汎用メッセージ」までは必ず出る安全側のフォールバックにするため、コードそのものを文中に
 * 含めて返す。
 *
 * ただし `auth_error` は URL クエリなので **誰でも任意の値を入れられる**。コードをそのまま
 * 文中に出すと、細工したリンクを踏ませるだけで攻撃者の文章をアプリ公式の案内として表示
 * できてしまう (React がエスケープするのでスクリプト実行は無いが、文面そのものが偽装に使える)。
 * そこで「未知コードでも必ず何か出す」は保ったまま、出すコードのほうを isSafeAuthErrorCode
 * で絞る ―― 沈黙を避ける目的は満たしつつ、任意文の表示経路は塞ぐ。
 */
export function describeAuthError(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case "not_invited":
      return "このメールアドレスは招待されていないため連携できません。管理者に招待を依頼してください。";
    case "insufficient_scope":
      return "必要な権限が許可されなかったため連携できませんでした。もう一度連携し、確認画面ですべての項目にチェックを入れてください。";
    case "login_required":
      return "GitHub 連携には先に Google でログインする必要があります。ログインしてから改めてお試しください。";
    default:
      return isSafeAuthErrorCode(code)
        ? `連携に失敗しました (${code})`
        : "連携に失敗しました";
  }
}

/**
 * 未知コードを画面にそのまま出してよいか。サーバー側が実際に送るコードは
 * `github_oauth_error: access_denied` のような ASCII の識別子だけなので、それを通せる
 * 最小限の文字種に限る。
 *
 * 意図的に落としているもの:
 * - 非 ASCII (日本語など) ―― 日本語 UI に日本語の偽メッセージを混ぜるのが一番効く手口
 * - `/` ―― 許すと `https://evil.example` のような誘導先を丸ごと表示できてしまう
 * - 長い文字列 ―― 文章を流し込む余地とレイアウト破壊の両方を防ぐ
 *
 * 弾いた場合もコード抜きの汎用メッセージは必ず出す (null にはしない)。表示が消えると
 * 「弾かれたのに何も出ない」という、この機能が生まれた原因そのものに戻ってしまうため。
 */
export function isSafeAuthErrorCode(code: string): boolean {
  return code.length <= 64 && /^[A-Za-z0-9_.: -]+$/.test(code);
}
