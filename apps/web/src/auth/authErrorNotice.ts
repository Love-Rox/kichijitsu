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
      return `連携に失敗しました (${code})`;
  }
}
